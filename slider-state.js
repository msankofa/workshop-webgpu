const STORAGE_KEY = 'pcw:sliderStates';

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// -> { [name]: { savedAt: isoString, values: { [controlName]: number|string|boolean } } }
export function listStates() {
  return readStore();
}

export function saveState(name, values) {
  const store = readStore();
  store[name] = { savedAt: new Date().toISOString(), values };
  writeStore(store);
}

export function deleteState(name) {
  const store = readStore();
  delete store[name];
  writeStore(store);
}
