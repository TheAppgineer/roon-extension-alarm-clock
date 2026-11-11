# Changelog

All notable changes follow [SemVer](https://semver.org/).

## [0.10.0] - 2026-11-10

### Changed
- Base image: `multiarch/alpine:*-v3.12` → official `node:22-alpine`.
  Node 12.22.12 → 22.x. Node uses its own bundled ICU time zone data
  (2026e in Node 22.23), not the OS tzdata files.
- Official image keeps amd64, arm64, arm/v6 and arm/v7.
- Build is multi-arch through `--platform`. Build argument `build_arch` removed.

### Fixed
- America/Vancouver used PST after 2026-11-01. BC moved to permanent -07 (MST).
  Source: https://www2.gov.bc.ca/gov/content/governments/celebrating-british-columbia/daylight-saving-time
- Extension reported version 0.9.1 to Roon. It now matches `package.json`.

### Documentation
- README: Node.js 22 or higher. Note on `TZ` and Node's bundled time zone data.

### Added
- `test/smoke.sh`. It checks the Vancouver UTC offset (420) in July and December.
