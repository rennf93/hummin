import { quantity } from "./quantity.mjs";
export function total(items, taxRate) {
	const subtotal = items.reduce((sum, item) => sum + item.price * quantity(item.quantity), 0);
	return subtotal * (1 + (taxRate ?? 0.2));
}
