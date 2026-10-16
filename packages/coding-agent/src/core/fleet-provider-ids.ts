import type { Model } from "@earendil-works/pi-ai";

// Engine prefixes of hummin-local provider ids (`${engine}-${host}-${port}`); keep in sync with ENGINE_NAMES in extensions/hummin-local.ts.
export const FLEET_ENGINES = ["colibri", "llamacpp"] as const;

const FLEET_PROVIDER_ID = new RegExp(`^(${FLEET_ENGINES.join("|")})-.+-\\d+$`);

/** hummin-local tags every model it registers with `humminHost`. */
export function isFleetModel(model: Model<any>): boolean {
	return "humminHost" in model;
}

/** Id-only check for UI that has no models at hand; a cloud provider named like `llamacpp-x-1` would match too. */
export function isFleetProviderId(providerId: string): boolean {
	return FLEET_PROVIDER_ID.test(providerId);
}
