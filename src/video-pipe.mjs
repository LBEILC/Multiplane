export async function writeFrame(stream, bytes) {
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await new Promise((resolve, reject) => stream.write(bytes.subarray(offset, offset + chunkSize), error => error ? reject(error) : resolve()));
  }
}
