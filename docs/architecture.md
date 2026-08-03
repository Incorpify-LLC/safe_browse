# Architecture and privacy boundary

## Data flow

1. An invited parent creates a child and a ten-minute enrollment code in the Access-protected dashboard.
2. The elevated MSI installs a Windows service and enrolls the device. Its random device token is protected with machine-scoped DPAPI.
3. The service downloads the latest policy and versioned category manifest, verifies hashes/signatures, and evaluates DNS locally.
4. Browser extensions send top-level hostnames to the native host. The native host talks to the service over an ACL-restricted named pipe.
5. The service batches navigation and block events. Cloudflare D1 retains them for 30 days.
6. Access decisions increment a policy version. Devices observe changes during their 60-second sync.

## Trust boundaries

- Parent routes require a Cloudflare Access JWT whose issuer and audience are verified by the Worker.
- Device routes use opaque 256-bit bearer tokens. D1 stores only SHA-256 token hashes.
- Enrollment codes are random, single-use, stored as hashes, and expire after ten minutes.
- Device credentials are scoped to one device and one household and can be revoked.
- R2 artifacts are delivered through authenticated device routes and checked against a signed manifest.
- The browser extension is presentation and navigation telemetry only. Removing it does not remove DNS enforcement.

## Known MVP limits

- Domain filtering cannot classify individual HTTPS pages or distinguish content hosted on the same domain.
- A determined Windows administrator can remove or bypass the agent. The threat model is a standard child account.
- Browser or application VPNs that tunnel over ordinary HTTPS cannot all be identified without invasive traffic inspection.
- The first release is x64 and one child profile per PC.
