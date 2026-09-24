// Engine-worker boot script. Two responsibilities before invoking the TeaVM
// bundle's main():
//
// 1. Load Emscripten-compiled gdx.wasm.js. libGDX-TeaVM's `Gdx2DPixmap`
//    routes Pixmap operations through `Gdx.Gdx.prototype.g2d_*`, which only
//    exist after the wasm module has resolved into an instance. The script's
//    top-level `asyncCall()` does `window.Gdx = await Gdx()` — `window` is
//    undefined in workers, so that assignment throws and the global `Gdx`
//    is left as the factory function. We instantiate explicitly here, await
//    it, and assign the result to `self.Gdx` ourselves.
//
// 2. importScripts engine-worker.js and call its exported main(). TeaVM
//    bundles export but don't auto-invoke main (same pattern as
//    worker-boot.js for the extraction worker).

// The script's own auto-init throws a "window is not defined" rejection at
// import time. Suppress just that specific case so it doesn't pollute the
// console — our own Gdx() call is what actually populates self.Gdx.
self.addEventListener('unhandledrejection', (e) => {
	const msg = e.reason && (e.reason.message || String(e.reason));
	if (msg && /window is not defined/.test(msg)) {
		e.preventDefault();
	}
});

// Early message buffer. Main thread posts the OffscreenCanvas immediately
// after constructing the worker, but our Java handler doesn't register until
// engine-worker.js loads + main() runs — which is gated on async wasm
// instantiation. Without buffering, the init message fires into a worker
// with no listener and is silently dropped.
//
// Java code calls __installMessageHandler(fn) once it's ready; the buffer
// is replayed at that moment, after which messages flow straight to fn.
(function installMessageBuffer() {
	const buffered = [];
	let installed = null;
	self.addEventListener('message', (e) => {
		if (installed) {
			installed(e.data);
		}
		else {
			buffered.push(e.data);
		}
	});
	self.__installMessageHandler = function(fn) {
		installed = fn;
		while (buffered.length) {
			try { installed(buffered.shift()); }
			catch (err) { self.postMessage('engine-worker-boot: handler threw on buffered message: ' + err); }
		}
	};
})();

// IndexedDB helpers — replace OPFS. Same symbols OpfsBridge expects on `self`.
// DB name must match main-thread opfs.DhKSuwVr.js (warsmash-w3zip).
self._w3Root = null;
self._w3Files = new Map(); // path -> { size }
self._w3MpqHandles = new Map(); // path -> Int8Array full file
self._w3ExtractedRoot = null;
self._w3Idb = null;
const W3_IDB_NAME = "warsmash-w3zip";
const W3_IDB_STORE = "files";

function w3OpenIdb() {
	if (self._w3Idb) return Promise.resolve(self._w3Idb);
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(W3_IDB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(W3_IDB_STORE)) db.createObjectStore(W3_IDB_STORE);
		};
		req.onsuccess = () => { self._w3Idb = req.result; resolve(req.result); };
		req.onerror = () => reject(req.error);
	});
}

function w3IdbGet(key) {
	return w3OpenIdb().then((db) => new Promise((resolve, reject) => {
		const r = db.transaction(W3_IDB_STORE, "readonly").objectStore(W3_IDB_STORE).get(key);
		r.onsuccess = () => resolve(r.result ?? null);
		r.onerror = () => reject(r.error);
	}));
}

function w3IdbKeys() {
	return w3OpenIdb().then((db) => new Promise((resolve, reject) => {
		const r = db.transaction(W3_IDB_STORE, "readonly").objectStore(W3_IDB_STORE).getAllKeys();
		r.onsuccess = () => resolve(r.result || []);
		r.onerror = () => reject(r.error);
	}));
}

async function w3InitOpfs() {
	try {
		const keys = await w3IdbKeys();
		self._w3Files.clear();
		for (const k of keys) {
			if (!k || k === "__meta_zip_etag") continue;
			// size unknown without reading; use 1 as placeholder, real size on open
			self._w3Files.set(String(k).replace(/\\/g, "/"), { size: 1 });
		}
		// Refine sizes for a sample? skip — w3FileSize can fetch
		self.postMessage("engine-worker-boot: indexed " + self._w3Files.size + " files from IndexedDB (w3.zip)");
		if (self._w3Files.size === 0) {
			self.postMessage("engine-worker-boot: WARN IndexedDB empty — open main page and wait for [w3zip] done first");
		}
	} catch (e) {
		self.postMessage("engine-worker-boot: IndexedDB init failed: " + e);
	}
}

function w3ToInt8(data) {
	if (!data) return null;
	if (data instanceof Int8Array) return data;
	if (data instanceof Uint8Array) return new Int8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return new Int8Array(data);
	return new Int8Array(data);
}

self.w3ReadFullAsync = async function(path) {
	const p = String(path).replace(/\\/g, "/").replace(/^\/+/, "");
	let data = await w3IdbGet(p);
	if (!data) {
		// try case-insensitive
		for (const k of self._w3Files.keys()) {
			if (k.toLowerCase() === p.toLowerCase()) {
				data = await w3IdbGet(k);
				break;
			}
		}
	}
	const out = w3ToInt8(data);
	if (!out) throw new Error("IDB path not found: " + path);
	const e = self._w3Files.get(p) || self._w3Files.get(path);
	if (e) e.size = out.byteLength;
	return out;
};

self.w3ReadRangeAsync = async function(path, offset, length) {
	const full = await self.w3ReadFullAsync(path);
	return full.subarray(offset, offset + length);
};

self.w3ListPathsWithPrefix = function(prefix) {
	const out = [];
	const pre = String(prefix || "");
	for (const p of self._w3Files.keys()) if (p.startsWith(pre)) out.push(p);
	return out.join("\n");
};

self.w3FileSize = function(path) {
	const p = String(path).replace(/\\/g, "/");
	const e = self._w3Files.get(p);
	return e ? e.size : -1;
};

self.w3FindMpqFiles = function() {
	const out = [];
	for (const p of self._w3Files.keys()) {
		const slash = p.lastIndexOf("/");
		const name = (slash === -1 ? p : p.substring(slash + 1)).toLowerCase();
		if (name.endsWith(".mpq")) out.push(p);
	}
	out.sort();
	return out.join("\n");
};

self.w3OpenMpqHandleAsync = async function(path) {
	const p = String(path).replace(/\\/g, "/");
	if (self._w3MpqHandles.has(p)) return true;
	const full = await self.w3ReadFullAsync(p);
	self._w3MpqHandles.set(p, full);
	return true;
};

self.w3CloseMpqHandle = function(path) {
	self._w3MpqHandles.delete(String(path).replace(/\\/g, "/"));
};

self.w3ReadMpq = function(path, offset, length, buf, bufOffset) {
	const full = self._w3MpqHandles.get(String(path).replace(/\\/g, "/"));
	if (!full) throw new Error("no open handle for " + path);
	const view = (bufOffset === 0 && buf.byteLength === length)
		? buf
		: new Int8Array(buf.buffer, buf.byteOffset + bufOffset, length);
	view.set(full.subarray(offset, offset + length));
	return length;
};

self.w3MpqSize = function(path) {
	const full = self._w3MpqHandles.get(String(path).replace(/\\/g, "/"));
	return full ? full.byteLength : -1;
};

self.w3WriteExtractedAsync = async function() { throw new Error("engine worker does not write"); };
self.w3ClearExtracted = async function() { throw new Error("engine worker does not clear"); };
self.w3DropUploadAsync = async function() { throw new Error("engine worker does not drop"); };

self.w3ReadExtractedAsync = async function(relPath) {
	try {
		return await self.w3ReadFullAsync(relPath);
	} catch (e) {
		return null;
	}
};

// Also expose main-thread style bridges for MainOpfsBridge code paths
self.w3MainListExtractedAsync = async function() {
	const keys = [...self._w3Files.keys()];
	return keys.join("\n");
};
self.w3MainReadExtractedAsync = async function(path) {
	try { return await self.w3ReadFullAsync(path); }
	catch (e) { return null; }
};

// Engine-internal assets (warsmash.ini, abilityBehaviors/*.json, etc.) live
// in core/assets/ and get bundled into app.js by gdx-teavm's asset loader on
// the main-thread build. The engine worker has none of that infrastructure;
// we fetch the same assets by parsing the preload.txt manifest gdx-teavm
// already produces, then expose them to Java via __engineAssets.
self.__engineAssets = new Map();
self.__engineAssetPaths = [];
async function w3FetchEngineAssets() {
	const r = await fetch('assets/preload.txt', { cache: 'no-store' });
	if (!r.ok) {
		self.postMessage('engine-worker-boot: WARN preload.txt not reachable (' + r.status + ')');
		return;
	}
	const lines = (await r.text()).split('\n');
	const relPaths = [];
	for (const line of lines) {
		// gdx-teavm tags entries by FileType: i = Internal (engine assets),
		// c = Classpath (libGDX-bundled resources like lsans-15.fnt/png and
		// the built-in shaders). The engine looks both up via
		// Gdx.files.internal/classpath and we collapse them onto the same
		// in-memory layer in the worker, so we fetch both kinds.
		if (!line.startsWith('i:b:') && !line.startsWith('c:b:')) continue;
		const after = line.substring(4);
		const lastColon = after.lastIndexOf(':');
		const second = after.lastIndexOf(':', lastColon - 1);
		const rawPath = after.substring(0, second);
		// Strip leading '/' so the URL is relative to assets/
		relPaths.push(rawPath.startsWith('/') ? rawPath.substring(1) : rawPath);
	}
	const tasks = relPaths.map(async (rel) => {
		try {
			const ar = await (await fetch('assets/' + rel, { cache: 'no-store' })).arrayBuffer();
			self.__engineAssets.set(rel, new Int8Array(ar));
			self.__engineAssetPaths.push(rel);
		}
		catch (e) {
			self.postMessage('engine-worker-boot: WARN fetch failed ' + rel + ': ' + e);
		}
	});
	await Promise.all(tasks);
	self.postMessage('engine-worker-boot: fetched ' + self.__engineAssets.size
		+ ' engine assets (' + Array.from(self.__engineAssets.values()).reduce((a, b) => a + b.byteLength, 0) + ' bytes)');
}

// jpeg-js: pure-JS JPEG decoder. WC3 uses JPEG BLPs for many UI textures
// (the menu background, button frames, unit portraits). The browser's
// native createImageBitmap discards their alpha channel; jpeg-js preserves
// the BGRA. Loaded the same way the main-thread build does in index.html
// — via importScripts here since we're in a worker.
self.postMessage('engine-worker-boot: importing jpeg-js');
try {
	importScripts('scripts/jpeg-js.js');
}
catch (err) {
	self.postMessage('engine-worker-boot: WARN jpeg-js import failed: ' + err);
}

self.postMessage('engine-worker-boot: importing gdx.wasm.js');
try {
	importScripts('scripts/gdx.wasm.js');
}
catch (err) {
	self.postMessage('engine-worker-boot: ERROR loading gdx.wasm.js: ' + err);
	throw err;
}

self.postMessage('engine-worker-boot: gdx.wasm.js imported, instantiating module…');

// `Gdx` here is the factory function the imported script left in worker scope.
// Calling it returns the wasm-loaded module instance via moduleArg.ready.
// `locateFile` is harmless when the wasm is base64-embedded inline (which it
// is) but kept for symmetry with the documented Emscripten pattern.
Promise.all([
	self.Gdx({ locateFile: (path) => 'scripts/' + path }),
	w3InitOpfs(),
	w3FetchEngineAssets(),
])
	.then(([gdxInstance]) => {
		self.Gdx = gdxInstance;
		self.postMessage('engine-worker-boot: gdx.wasm module instantiated');
		try {
			importScripts('engine-worker.js');
		}
		catch (err) {
			self.postMessage('engine-worker-boot: ERROR loading engine-worker.js: ' + err);
			throw err;
		}
		self.postMessage('engine-worker-boot: engine bundle loaded, invoking main()');
		self.main();
	})
	.catch((err) => {
		self.postMessage('engine-worker-boot: ERROR boot rejected: '
			+ (err && err.message ? err.message : String(err)));
	});

// Watchdog: if neither the module nor an error has surfaced after 5s, that's
// almost certainly a wasm-instantiation hang. Surface it so we don't stare at
// "instantiating module…" forever.
setTimeout(() => {
	if (typeof self.Gdx === 'function') {
		self.postMessage('engine-worker-boot: WARN gdx.wasm has not resolved after 5s — '
			+ 'check console for wasm errors or CSP blocks on WebAssembly');
	}
}, 5000);
