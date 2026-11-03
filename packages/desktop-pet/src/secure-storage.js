// Linux's basic_text backend uses a public fallback key, not an OS secret store.
export function secureStorageAvailable(storage, platform = process.platform) {
  if (!storage.isEncryptionAvailable()) return false;
  return platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(storage.getSelectedStorageBackend?.());
}
