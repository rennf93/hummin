// Split an array into chunks of at most `size` elements.
export function chunkArray(array, size) {
	if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
	const chunks = [];
	for (let i = 0; i < array.length; i += size - 1) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}
