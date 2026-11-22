/** Only literal unicast IPv4 destinations; URLs and wildcard addresses are invalid. */
export function validBridgeIp(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) > 0 && Number(parts[0]) < 224;
}
