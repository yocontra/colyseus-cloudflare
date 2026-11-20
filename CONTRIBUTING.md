# Contributing

Use Node 24 or newer. Install from the lockfile with `npm ci`, then run
`npm run check` and `npm pack --dry-run`.

The README shows how to run the example with the npm release. The Workerd CI job
installs a tarball from the current checkout into the example and runs the same
smoke test. Run the example after changes to the wire protocol, room
lifecycle, physics, or package exports. Use local test identities and storage.

Keep the PlayCanvas and Colyseus versions in the package and the example
aligned. Preserve the upstream notices when regenerating the Ammo assets.
