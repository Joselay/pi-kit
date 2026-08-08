# Setup

Verify installation and credentials:

```bash
gws --version
gws auth status
```

Install a missing CLI from <https://github.com/googleworkspace/cli>. First-time interactive OAuth setup requires `gcloud`:

```bash
gws auth setup
gws auth login -s docs,drive,gmail,sheets
gws auth status
```

For service-account Application Default Credentials:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

Setup is complete when `gws auth status` reports valid credentials.
