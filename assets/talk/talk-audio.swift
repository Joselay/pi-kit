// Full-duplex audio I/O with macOS voice-processing echo cancellation (AEC).
//
// This is the client-side audio layer that upstream Codex leaves to its GUI
// clients: mic capture and speaker playback run through one AVAudioEngine with
// the Apple voice-processing unit enabled, so the mic stream has the
// assistant's own speaker output cancelled out. That makes always-open-mic
// (full-duplex) voice with barge-in work on speakers, not just headphones.
//
// Protocol (all audio is raw PCM16, mono, 24 kHz, native endian):
//   stdin  -> speaker playback
//   stdout <- echo-cancelled microphone
//   SIGUSR1: drop any buffered playback immediately (barge-in flush)
//   stderr: "ready aec=1" (or aec=0) once the engine is running, diagnostics
//           otherwise. The parent reads the aec flag: without cancellation it
//           has to gate the mic while the assistant speaks instead.
//
// Build: swiftc -O talk-audio.swift -o talk-audio

import AVFoundation
import Foundation
import os

let sampleRate = 24_000.0

func warn(_ message: String) {
    FileHandle.standardError.write(Data(("voice-audio: " + message + "\n").utf8))
}

/// Playback queue fed by stdin, drained by the source node's render callback.
///
/// A fixed circular buffer rather than a Swift array shifted from the front:
/// `pop` runs on the realtime render thread, where an O(capacity) `removeFirst`
/// of a multi-megabyte array — and the allocator traffic behind it — is enough
/// to miss the deadline and break the audio up. Every operation here is a
/// bounded copy of just the frames involved, under a lock that hands the
/// render thread priority (`os_unfair_lock`).
final class PlaybackRing {
    // Cap buffered playback at 120 s so a stalled consumer can't grow unbounded.
    private let capacity = Int(sampleRate) * 120
    private var buffer: [Float]
    private var head = 0 // index of the next sample to play
    private var count = 0 // samples currently queued
    private let lock: UnsafeMutablePointer<os_unfair_lock_s> = {
        let pointer = UnsafeMutablePointer<os_unfair_lock_s>.allocate(capacity: 1)
        pointer.initialize(to: os_unfair_lock_s())
        return pointer
    }()

    init() {
        buffer = [Float](repeating: 0, count: capacity)
    }

    func push(_ source: UnsafePointer<Float>, _ frames: Int) {
        guard frames > 0 else { return }
        var source = source
        var frames = frames
        // More than the whole buffer in one go: only the newest can survive.
        if frames > capacity {
            source = source.advanced(by: frames - capacity)
            frames = capacity
        }
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        if count + frames > capacity {
            let drop = count + frames - capacity
            head = (head + drop) % capacity
            count -= drop
        }
        var tail = (head + count) % capacity
        buffer.withUnsafeMutableBufferPointer { destination in
            guard let base = destination.baseAddress else { return }
            var left = frames
            var from = source
            while left > 0 {
                let chunk = min(left, capacity - tail)
                base.advanced(by: tail).update(from: from, count: chunk)
                from = from.advanced(by: chunk)
                tail = (tail + chunk) % capacity
                left -= chunk
            }
        }
        count += frames
    }

    func pop(into out: UnsafeMutablePointer<Float>, count wanted: Int) {
        os_unfair_lock_lock(lock)
        let available = min(wanted, count)
        var index = head
        buffer.withUnsafeMutableBufferPointer { source in
            guard let base = source.baseAddress else { return }
            var left = available
            var to = out
            while left > 0 {
                let chunk = min(left, capacity - index)
                to.update(from: base.advanced(by: index), count: chunk)
                to = to.advanced(by: chunk)
                index = (index + chunk) % capacity
                left -= chunk
            }
        }
        head = index
        count -= available
        os_unfair_lock_unlock(lock)
        // Underrun: the rest of the callback's request is silence.
        if available < wanted {
            out.advanced(by: available).update(repeating: 0, count: wanted - available)
        }
    }

    func clear() {
        os_unfair_lock_lock(lock)
        head = 0
        count = 0
        os_unfair_lock_unlock(lock)
    }
}

/// Microphone bytes on their way to stdout.
///
/// The tap callback runs on a high-priority audio thread, and stdout is a pipe
/// the parent drains on its own schedule: writing from the callback lets a busy
/// parent stall capture, and a `FileHandle` write to a closed pipe raises an
/// Objective-C exception no Swift `do/catch` can take. Hand the bytes over
/// here and let an ordinary thread do the blocking `write(2)`.
final class StdoutWriter {
    private var pending: [Data] = []
    private let condition = NSCondition()
    // ~4 s of 24 kHz PCM16. Past that the parent is gone or wedged, and the
    // freshest audio is worth more than the backlog behind it.
    private let maxPending = 200

    init() {
        let thread = Thread { [self] in run() }
        thread.name = "voice-audio.stdout"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func write(_ data: Data) {
        condition.lock()
        if pending.count >= maxPending {
            pending.removeFirst(pending.count - maxPending + 1)
        }
        pending.append(data)
        condition.signal()
        condition.unlock()
    }

    private func run() {
        while true {
            condition.lock()
            while pending.isEmpty { condition.wait() }
            let batch = pending
            pending.removeAll(keepingCapacity: true)
            condition.unlock()
            for chunk in batch where !writeAll(chunk) {
                // stdout is gone: the parent has exited, and so should we.
                exit(0)
            }
        }
    }

    /// `write(2)` with partial-write and EINTR retry; false once stdout is gone.
    private func writeAll(_ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let written = Foundation.write(1, pointer, left)
                if written > 0 {
                    pointer = pointer.advanced(by: written)
                    left -= written
                    continue
                }
                if written < 0 && errno == EINTR { continue }
                if written < 0 && errno == EAGAIN {
                    usleep(1000)
                    continue
                }
                return false
            }
            return true
        }
    }
}

/// The engine, and everything that has to be rebuilt when the audio route
/// changes under it.
final class VoiceEngine {
    let ring = PlaybackRing()
    private let engine = AVAudioEngine()
    private let stdout = StdoutWriter()
    private let ioFormat: AVAudioFormat
    private let micFormat: AVAudioFormat
    private var sourceNode: AVAudioSourceNode?
    private var converter: AVAudioConverter?
    private let configQueue = DispatchQueue(label: "voice-audio.config")
    private var running = false
    private var rebuildGeneration = 0

    private(set) var echoCancelled = false

    init?() {
        guard let io = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
        ), let mic = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true
        ) else {
            warn("could not create audio formats")
            return nil
        }
        ioFormat = io
        micFormat = mic
    }

    func start() throws {
        // Voice processing has to be switched on while the engine is stopped; it
        // rebuilds the IO unit, which is what invalidates the formats below.
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            echoCancelled = true
        } catch {
            warn("voice processing unavailable, echo cancellation disabled: \(error.localizedDescription)")
        }
        try configure()
        try engine.start()
        running = true

        // Plugging in headphones (or unplugging them, or a Bluetooth device
        // arriving) swaps the device out from under the engine: CoreAudio stops
        // it and posts this, and without rebuilding the graph at the new
        // hardware format both directions go silent for the rest of the session.
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.scheduleRebuild()
        }
    }

    private func configure() throws {
        let outputFormat = engine.outputNode.outputFormat(forBus: 0)
        let inputRate = engine.inputNode.outputFormat(forBus: 0).sampleRate
        guard inputRate > 0, outputFormat.sampleRate > 0 else {
            throw NSError(
                domain: "voice-audio", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no usable audio device (input \(inputRate) Hz)"],
            )
        }
        // The voice-processed input node advertises a multichannel format; tap it
        // as mono at the hardware rate instead, which the VP unit supports.
        guard let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false
        ), let converter = AVAudioConverter(from: inputFormat, to: micFormat) else {
            throw NSError(
                domain: "voice-audio", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "could not convert mic audio from \(inputRate) Hz"],
            )
        }
        self.converter = converter

        // Speaker path: stdin PCM -> ring -> source node -> mixer (handles SRC).
        if sourceNode == nil {
            let ring = ring
            let node = AVAudioSourceNode(format: ioFormat) { _, _, frameCount, audioBufferList -> OSStatus in
                let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
                guard let data = buffers[0].mData else { return noErr }
                ring.pop(into: data.assumingMemoryBound(to: Float.self), count: Int(frameCount))
                return noErr
            }
            sourceNode = node
            engine.attach(node)
        }
        guard let sourceNode else { return }
        engine.connect(sourceNode, to: engine.mainMixerNode, format: ioFormat)
        // With voice processing enabled the output unit fails to initialize
        // (-10875) unless the mixer feeds it at the hardware format.
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outputFormat)

        // Mic path: input tap (voice-processed) -> 24 kHz PCM16 -> stdout.
        engine.inputNode.removeTap(onBus: 0)
        engine.inputNode.installTap(onBus: 0, bufferSize: 960, format: inputFormat) { [weak self] buffer, _ in
            self?.emit(buffer)
        }
        warn("engine at \(outputFormat.sampleRate) Hz/\(outputFormat.channelCount) ch out, \(inputRate) Hz in")
    }

    private func emit(_ buffer: AVAudioPCMBuffer) {
        guard let converter, buffer.frameLength > 0 else { return }
        let ratio = sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }
        var fed = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if let conversionError {
            warn("mic conversion failed: \(conversionError.localizedDescription)")
            return
        }
        guard converted.frameLength > 0, let channel = converted.int16ChannelData else { return }
        stdout.write(Data(bytes: channel[0], count: Int(converted.frameLength) * 2))
    }

    /// A route change arrives as a burst of notifications; settle before acting.
    private func scheduleRebuild() {
        configQueue.async { [self] in
            rebuildGeneration += 1
            let generation = rebuildGeneration
            configQueue.asyncAfter(deadline: .now() + 0.2) { [self] in
                guard generation == rebuildGeneration, running else { return }
                rebuild()
            }
        }
    }

    private func rebuild() {
        warn("audio route changed, rebuilding")
        engine.stop()
        do {
            try configure()
            try engine.start()
        } catch {
            warn("failed to rebuild audio engine: \(error.localizedDescription)")
        }
    }
}

// A closed stdout should end the process through our own write path, not kill
// it mid-callback.
signal(SIGPIPE, SIG_IGN)

// Without microphone access the engine starts happily and delivers digital
// silence — a session that looks live and cannot hear anything. Fail loudly
// instead, so the parent can say why.
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    break
case .notDetermined:
    let granted = DispatchSemaphore(value: 0)
    var allowed = false
    AVCaptureDevice.requestAccess(for: .audio) { ok in
        allowed = ok
        granted.signal()
    }
    if granted.wait(timeout: .now() + 30) == .timedOut || !allowed {
        warn("microphone access was not granted")
        exit(1)
    }
default:
    warn("microphone access denied; enable it in System Settings > Privacy & Security > Microphone")
    exit(1)
}

guard let voice = VoiceEngine() else { exit(1) }

// Barge-in: the parent signals SIGUSR1 to drop everything queued for playback.
signal(SIGUSR1, SIG_IGN)
let flushSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .global())
flushSource.setEventHandler { voice.ring.clear() }
flushSource.resume()

// Playback feed: read raw PCM16 from stdin until EOF. A pipe read can land
// mid-sample, so carry the odd byte into the next read — dropping it would
// shift every following sample by one byte and turn playback into noise.
DispatchQueue.global(qos: .userInitiated).async {
    let input = FileHandle.standardInput
    var pending = Data()
    var floats: [Float] = []
    while true {
        let data = input.availableData
        if data.isEmpty { exit(0) }
        if pending.isEmpty { pending = data } else { pending.append(data) }
        let usable = pending.count & ~1
        if usable == 0 { continue }
        let frames = usable / 2
        if floats.count < frames { floats = [Float](repeating: 0, count: frames) }
        pending.withUnsafeBytes { raw in
            for index in 0..<frames {
                floats[index] = Float(raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)) / 32768.0
            }
        }
        floats.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            voice.ring.push(base, frames)
        }
        pending = usable < pending.count ? pending.subdata(in: usable..<pending.count) : Data()
    }
}

do {
    try voice.start()
} catch {
    warn("audio engine failed to start: \(error.localizedDescription)")
    exit(1)
}

warn("ready aec=\(voice.echoCancelled ? 1 : 0)")
dispatchMain()
