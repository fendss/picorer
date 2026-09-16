export function encodeFloat32Vector(
  vector: readonly number[],
  dimensions: number,
): Buffer {
  if (vector.length !== dimensions) {
    throw new Error(`Embedding vector must have ${dimensions} dimensions`);
  }
  const encoded = Buffer.allocUnsafe(
    dimensions * Float32Array.BYTES_PER_ELEMENT,
  );
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value");
    }
    encoded.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return encoded;
}

export function decodeFloat32Vector(
  value: Uint8Array,
  dimensions: number,
): Float32Array {
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (value.byteLength !== expectedBytes) {
    throw new Error(
      `Stored embedding vector has ${value.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const decoded = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const item = view.getFloat32(
      index * Float32Array.BYTES_PER_ELEMENT,
      true,
    );
    if (!Number.isFinite(item)) {
      throw new Error("Stored embedding vector contains a non-finite value");
    }
    decoded[index] = item;
  }
  return decoded;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
