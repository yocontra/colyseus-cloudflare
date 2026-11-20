# Contributing

Use Node 24 or newer. Install from the lockfile with `npm ci`, then run
`npm run check` and `npm pack --dry-run`.

The README shows how to install the tarball into the example and test it with
local Wrangler. Run the example after changes to the wire protocol, room
lifecycle, physics, or package exports. Use local test identities and storage.

Keep the PlayCanvas and Colyseus versions in the package and the example
aligned. Preserve the upstream notices when regenerating the Ammo assets.
