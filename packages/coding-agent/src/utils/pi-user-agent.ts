import { formatUserAgent } from "@earendil-works/pi-ai";

/** pi's `User-Agent` for its own network requests; the same detailed form pi-ai sends to providers.
 * formatUserAgent keeps the `pi/<version>` wire prefix pi.dev's catalog protocol routes on. */
export function getPiUserAgent(version: string): string {
	return formatUserAgent({ userAgent: "detailed", version });
}
