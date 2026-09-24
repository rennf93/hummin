export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	// Wire-format identifier: pi.dev's catalog protocol redirects `pi/<version>`
	// user agents to version-negotiated shards, so this must stay `pi/`-prefixed.
	return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
