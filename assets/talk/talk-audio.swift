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
//   stderr: "ready" once the engine is running, diagnostics otherwise
//
// Build: swiftc -O voice-audio.swift -o voice-audio

import AVFoundation
import Foundation

let sampleRate = 24_000.0

func warn(_ message: String) {
    FileHandle.standardError.write(Data(("voice-audio: " + message + "\n").utf8))
}

// Playback queue fed by stdin, drained by the source node's render callback.
final class PlaybackRing {
    private var samples: [Float] = []
    private let lock = NSLock()
    // Cap buffered playback at 120 s so a stalled consumer can't grow unbounded.
    private let capacity = Int(sampleRate) * 120

    func push(_ incoming: [Float]) {
        lock.lock()
        defer { lock.unlock() }
        samples.append(contentsOf: incoming)
        if samples.count > capacity {
            samples.removeFirst(samples.count - capacity)
        }
    }

    func pop(into out: UnsafeMutablePointer<Float>, count: Int) {
        lock.lock()
        defer { lock.unlock() }
        let available = min(count, samples.count)
        for index in 0..<available { out[index] = samples[index] }
        for index in available..<count { out[index] = 0 }
        if available > 0 { samples.removeFirst(available) }
    }

    func clear() {
        lock.lock()
        samples.removeAll()
        lock.unlock()
    }
}

let engine = AVAudioEngine()
let ring = PlaybackRing()

do {
    try engine.inputNode.setVoiceProcessingEnabled(true)
} catch {
    warn("voice processing unavailable, echo cancellation disabled: \(error.localizedDescription)")
}

let outputHardwareFormat = engine.outputNode.outputFormat(forBus: 0)
let hardwareRate = engine.inputNode.outputFormat(forBus: 0).sampleRate
warn("output \(outputHardwareFormat.sampleRate) Hz/\(outputHardwareFormat.channelCount) ch, input \(hardwareRate) Hz")

guard let ioFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false
), let micFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true
) else {
    warn("could not create audio formats")
    exit(1)
}

// Speaker path: stdin PCM -> ring -> source node -> mixer (handles SRC to hardware).
let sourceNode = AVAudioSourceNode(format: ioFormat) { _, _, frameCount, audioBufferList -> OSStatus in
    let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
    guard let data = buffers[0].mData else { return noErr }
    ring.pop(into: data.assumingMemoryBound(to: Float.self), count: Int(frameCount))
    return noErr
}
engine.attach(sourceNode)
engine.connect(sourceNode, to: engine.mainMixerNode, format: ioFormat)
// With voice processing enabled the output unit fails to initialize (-10875)
// unless the mixer feeds it at the hardware format, so connect explicitly.
engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outputHardwareFormat)

// Mic path: input tap (voice-processed) -> convert to 24 kHz PCM16 -> stdout.
// The voice-processed input node advertises a multichannel format; tap it as
// mono at the hardware rate instead, which the VP unit supports.
guard let inputFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: hardwareRate, channels: 1, interleaved: false
), let converter = AVAudioConverter(from: inputFormat, to: micFormat) else {
    warn("could not create mic format converter (hardware rate \(hardwareRate))")
    exit(1)
}

engine.inputNode.installTap(onBus: 0, bufferSize: 960, format: inputFormat) { buffer, _ in
    let ratio = sampleRate / inputFormat.sampleRate
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
    FileHandle.standardOutput.write(Data(bytes: channel[0], count: Int(converted.frameLength) * 2))
}

// Barge-in: the parent signals SIGUSR1 to drop everything queued for playback.
signal(SIGUSR1, SIG_IGN)
let flushSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .global())
flushSource.setEventHandler { ring.clear() }
flushSource.resume()

// Playback feed: read raw PCM16 from stdin until EOF.
DispatchQueue.global(qos: .userInitiated).async {
    let input = FileHandle.standardInput
    while true {
        let data = input.availableData
        if data.isEmpty {
            exit(0)
        }
        var floats = [Float](repeating: 0, count: data.count / 2)
        data.withUnsafeBytes { raw in
            let pcm = raw.bindMemory(to: Int16.self)
            for index in 0..<floats.count { floats[index] = Float(pcm[index]) / 32768.0 }
        }
        ring.push(floats)
    }
}

do {
    try engine.start()
} catch {
    warn("audio engine failed to start: \(error.localizedDescription)")
    exit(1)
}

warn("ready")
dispatchMain()
