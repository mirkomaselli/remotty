import { Capacitor } from '@capacitor/core';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Preferences } from '@capacitor/preferences';
import type { PairingConfig } from '@remotty/shared';

const SERVER_URL_KEY = 'remotty.serverUrl';
const PAIR_FRAGMENT = 'remotty-pair=';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function isNativeLocalShell(): boolean {
  return isNativeApp() && window.location.hostname === 'localhost';
}

export async function redirectToSavedServer(): Promise<boolean> {
  if (!isNativeLocalShell()) return false;
  const { value } = await Preferences.get({ key: SERVER_URL_KEY });
  if (!value) return false;
  window.location.replace(value);
  return true;
}

export async function scanAndConnect(): Promise<void> {
  if (!isNativeApp()) throw new Error('QR scanning is available in the Android app.');
  const result = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
    scanInstructions: 'Scan the QR code shown by Remotty on your computer',
  });
  const pairing = parsePairingConfig(result.ScanResult);
  await Preferences.set({ key: SERVER_URL_KEY, value: pairing.serverUrl });
  const encoded = encodePairing(pairing);
  window.location.replace(`${pairing.serverUrl}/login#${PAIR_FRAGMENT}${encoded}`);
}

export function pairingFromFragment(): PairingConfig | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(PAIR_FRAGMENT)) return null;
  try {
    return parsePairingConfig(decodePairing(hash.slice(PAIR_FRAGMENT.length)));
  } catch {
    return null;
  }
}

export function clearPairingFragment(): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function parsePairingConfig(raw: string | PairingConfig): PairingConfig {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== 'object') throw new Error('Invalid Remotty QR code.');
  const candidate = value as Partial<PairingConfig>;
  if (
    candidate.version !== 1 ||
    typeof candidate.serverUrl !== 'string' ||
    typeof candidate.token !== 'string'
  ) {
    throw new Error('Invalid Remotty QR code.');
  }
  const url = new URL(candidate.serverUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The Remotty server URL must use HTTP or HTTPS.');
  }
  url.hash = '';
  url.search = '';
  return {
    version: 1,
    serverUrl: url.href.replace(/\/+$/, ''),
    token: candidate.token,
  };
}

function encodePairing(pairing: PairingConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(pairing));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodePairing(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
