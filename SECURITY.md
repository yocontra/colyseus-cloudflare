# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/yocontra/colyseus-cloudflare/security/advisories/new).

Applications authenticate players and route sockets to the correct Durable Object.
The example uses local test identities. Before deploying a derivative publicly,
authenticate requests, derive player identity on the server, and set admission
limits for your application.

Use reliable Colyseus input over this transport. Put limits on concurrent rooms
and validate application messages before they can change game state. Pass
`loadAmmo()` an asset URL controlled by your application.

The Ammo regeneration script pins the upstream PlayCanvas commit and checks the
SHA-256 digests before replacing generated files.
