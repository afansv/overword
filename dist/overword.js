// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2025-05-07
// @description  try to take over the world!
// @author       You
// @match        http://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

"use strict";
(function() {

var $goVersion = "go1.19.13";
Error.stackTraceLimit = Infinity;

var $NaN = NaN;
var $global, $module;
if (typeof window !== "undefined") { /* web page */
    $global = window;
} else if (typeof self !== "undefined") { /* web worker */
    $global = self;
} else if (typeof global !== "undefined") { /* Node.js */
    $global = global;
    $global.require = require;
} else { /* others (e.g. Nashorn) */
    $global = this;
}

if ($global === undefined || $global.Array === undefined) {
    throw new Error("no global object found");
}
if (typeof module !== "undefined") {
    $module = module;
}

if (!$global.fs && $global.require) {
    try {
        var fs = $global.require('fs');
        if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
            $global.fs = fs;
        }
    } catch (e) { /* Ignore if the module couldn't be loaded. */ }
}

if (!$global.fs) {
    var outputBuf = "";
    var decoder = new TextDecoder("utf-8");
    $global.fs = {
        constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
        writeSync: function writeSync(fd, buf) {
            outputBuf += decoder.decode(buf);
            var nl = outputBuf.lastIndexOf("\n");
            if (nl != -1) {
                console.log(outputBuf.substr(0, nl));
                outputBuf = outputBuf.substr(nl + 1);
            }
            return buf.length;
        },
        write: function write(fd, buf, offset, length, position, callback) {
            if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
            }
            var n = this.writeSync(fd, buf);
            callback(null, n);
        }
    };
}

var $linknames = {} // Collection of functions referenced by a go:linkname directive.
var $packages = {}, $idCounter = 0;
var $keys = m => { return m ? Object.keys(m) : []; };
var $flushConsole = () => { };
var $throwRuntimeError; /* set by package "runtime" */
var $throwNilPointerError = () => { $throwRuntimeError("invalid memory address or nil pointer dereference"); };
var $call = (fn, rcvr, args) => { return fn.apply(rcvr, args); };
var $makeFunc = fn => { return function(...args) { return $externalize(fn(this, new ($sliceType($jsObjectPtr))($global.Array.prototype.slice.call(args, []))), $emptyInterface); }; };
var $unused = v => { };
var $print = console.log;
// Under Node we can emulate print() more closely by avoiding a newline.
if (($global.process !== undefined) && $global.require) {
    try {
        var util = $global.require('util');
        $print = function(...args) { $global.process.stderr.write(util.format.apply(this, args)); };
    } catch (e) {
        // Failed to require util module, keep using console.log().
    }
}
var $println = console.log

var $initAllLinknames = () => {
    var names = $keys($packages);
    for (var i = 0; i < names.length; i++) {
        var f = $packages[names[i]]["$initLinknames"];
        if (typeof f == 'function') {
            f();
        }
    }
}

var $mapArray = (array, f) => {
    var newArray = new array.constructor(array.length);
    for (var i = 0; i < array.length; i++) {
        newArray[i] = f(array[i]);
    }
    return newArray;
};

// $mapIndex returns the value of the given key in m, or undefined if m is nil/undefined or not a map
var $mapIndex = (m, key) => {
    return typeof m.get === "function" ? m.get(key) : undefined;
};
// $mapDelete deletes the key and associated value from m.  If m is nil/undefined or not a map, $mapDelete is a no-op
var $mapDelete = (m, key) => {
    typeof m.delete === "function" && m.delete(key)
};
// Returns a method bound to the receiver instance, safe to invoke as a 
// standalone function. Bound function is cached for later reuse.
var $methodVal = (recv, name) => {
    var vals = recv.$methodVals || {};
    recv.$methodVals = vals; /* noop for primitives */
    var f = vals[name];
    if (f !== undefined) {
        return f;
    }
    var method = recv[name];
    f = method.bind(recv);
    vals[name] = f;
    return f;
};

var $methodExpr = (typ, name) => {
    var method = typ.prototype[name];
    if (method.$expr === undefined) {
        method.$expr = (...args) => {
            $stackDepthOffset--;
            try {
                if (typ.wrapped) {
                    args[0] = new typ(args[0]);
                }
                return Function.call.apply(method, args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return method.$expr;
};

var $ifaceMethodExprs = {};
var $ifaceMethodExpr = name => {
    var expr = $ifaceMethodExprs["$" + name];
    if (expr === undefined) {
        expr = $ifaceMethodExprs["$" + name] = (...args) => {
            $stackDepthOffset--;
            try {
                return Function.call.apply(args[0][name], args);
            } finally {
                $stackDepthOffset++;
            }
        };
    }
    return expr;
};

var $subslice = (slice, low, high, max) => {
    if (high === undefined) {
        high = slice.$length;
    }
    if (max === undefined) {
        max = slice.$capacity;
    }
    if (low < 0 || high < low || max < high || high > slice.$capacity || max > slice.$capacity) {
        $throwRuntimeError("slice bounds out of range");
    }
    if (slice === slice.constructor.nil) {
        return slice;
    }
    var s = new slice.constructor(slice.$array);
    s.$offset = slice.$offset + low;
    s.$length = high - low;
    s.$capacity = max - low;
    return s;
};

var $substring = (str, low, high) => {
    if (low < 0 || high < low || high > str.length) {
        $throwRuntimeError("slice bounds out of range");
    }
    return str.substring(low, high);
};

// Convert Go slice to an equivalent JS array type.
var $sliceToNativeArray = slice => {
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + slice.$length);
    }
    return slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
};

// Convert Go slice to a pointer to an underlying Go array.
// 
// Note that an array pointer can be represented by an "unwrapped" native array
// type, and it will be wrapped back into its Go type when necessary.
var $sliceToGoArray = (slice, arrayPtrType) => {
    var arrayType = arrayPtrType.elem;
    if (arrayType !== undefined && slice.$length < arrayType.len) {
        $throwRuntimeError("cannot convert slice with length " + slice.$length + " to pointer to array with length " + arrayType.len);
    }
    if (slice == slice.constructor.nil) {
        return arrayPtrType.nil; // Nil slice converts to nil array pointer.
    }
    if (slice.$array.constructor !== Array) {
        return slice.$array.subarray(slice.$offset, slice.$offset + arrayType.len);
    }
    if (slice.$offset == 0 && slice.$length == slice.$capacity && slice.$length == arrayType.len) {
        return slice.$array;
    }
    if (arrayType.len == 0) {
        return new arrayType([]);
    }

    // Array.slice (unlike TypedArray.subarray) returns a copy of an array range,
    // which is not sharing memory with the original one, which violates the spec
    // for slice to array conversion. This is incompatible with the Go spec, in
    // particular that the assignments to the array elements would be visible in
    // the slice. Prefer to fail explicitly instead of creating subtle bugs.
    $throwRuntimeError("gopherjs: non-numeric slice to underlying array conversion is not supported for subslices");
};

// Convert between compatible slice types (e.g. native and names).
var $convertSliceType = (slice, desiredType) => {
    if (slice == slice.constructor.nil) {
        return desiredType.nil; // Preserve nil value.
    }

    return $subslice(new desiredType(slice.$array), slice.$offset, slice.$offset + slice.$length);
}

var $decodeRune = (str, pos) => {
    var c0 = str.charCodeAt(pos);

    if (c0 < 0x80) {
        return [c0, 1];
    }

    if (c0 !== c0 || c0 < 0xC0) {
        return [0xFFFD, 1];
    }

    var c1 = str.charCodeAt(pos + 1);
    if (c1 !== c1 || c1 < 0x80 || 0xC0 <= c1) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xE0) {
        var r = (c0 & 0x1F) << 6 | (c1 & 0x3F);
        if (r <= 0x7F) {
            return [0xFFFD, 1];
        }
        return [r, 2];
    }

    var c2 = str.charCodeAt(pos + 2);
    if (c2 !== c2 || c2 < 0x80 || 0xC0 <= c2) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF0) {
        var r = (c0 & 0x0F) << 12 | (c1 & 0x3F) << 6 | (c2 & 0x3F);
        if (r <= 0x7FF) {
            return [0xFFFD, 1];
        }
        if (0xD800 <= r && r <= 0xDFFF) {
            return [0xFFFD, 1];
        }
        return [r, 3];
    }

    var c3 = str.charCodeAt(pos + 3);
    if (c3 !== c3 || c3 < 0x80 || 0xC0 <= c3) {
        return [0xFFFD, 1];
    }

    if (c0 < 0xF8) {
        var r = (c0 & 0x07) << 18 | (c1 & 0x3F) << 12 | (c2 & 0x3F) << 6 | (c3 & 0x3F);
        if (r <= 0xFFFF || 0x10FFFF < r) {
            return [0xFFFD, 1];
        }
        return [r, 4];
    }

    return [0xFFFD, 1];
};

var $encodeRune = r => {
    if (r < 0 || r > 0x10FFFF || (0xD800 <= r && r <= 0xDFFF)) {
        r = 0xFFFD;
    }
    if (r <= 0x7F) {
        return String.fromCharCode(r);
    }
    if (r <= 0x7FF) {
        return String.fromCharCode(0xC0 | r >> 6, 0x80 | (r & 0x3F));
    }
    if (r <= 0xFFFF) {
        return String.fromCharCode(0xE0 | r >> 12, 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
    }
    return String.fromCharCode(0xF0 | r >> 18, 0x80 | (r >> 12 & 0x3F), 0x80 | (r >> 6 & 0x3F), 0x80 | (r & 0x3F));
};

var $stringToBytes = str => {
    var array = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
        array[i] = str.charCodeAt(i);
    }
    return array;
};

var $bytesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i += 10000) {
        str += String.fromCharCode.apply(undefined, slice.$array.subarray(slice.$offset + i, slice.$offset + Math.min(slice.$length, i + 10000)));
    }
    return str;
};

var $stringToRunes = str => {
    var array = new Int32Array(str.length);
    var rune, j = 0;
    for (var i = 0; i < str.length; i += rune[1], j++) {
        rune = $decodeRune(str, i);
        array[j] = rune[0];
    }
    return array.subarray(0, j);
};

var $runesToString = slice => {
    if (slice.$length === 0) {
        return "";
    }
    var str = "";
    for (var i = 0; i < slice.$length; i++) {
        str += $encodeRune(slice.$array[slice.$offset + i]);
    }
    return str;
};

var $copyString = (dst, src) => {
    var n = Math.min(src.length, dst.$length);
    for (var i = 0; i < n; i++) {
        dst.$array[dst.$offset + i] = src.charCodeAt(i);
    }
    return n;
};

var $copySlice = (dst, src) => {
    var n = Math.min(src.$length, dst.$length);
    $copyArray(dst.$array, src.$array, dst.$offset, src.$offset, n, dst.constructor.elem);
    return n;
};

var $copyArray = (dst, src, dstOffset, srcOffset, n, elem) => {
    if (n === 0 || (dst === src && dstOffset === srcOffset)) {
        return;
    }

    if (src.subarray) {
        dst.set(src.subarray(srcOffset, srcOffset + n), dstOffset);
        return;
    }

    switch (elem.kind) {
        case $kindArray:
        case $kindStruct:
            if (dst === src && dstOffset > srcOffset) {
                for (var i = n - 1; i >= 0; i--) {
                    elem.copy(dst[dstOffset + i], src[srcOffset + i]);
                }
                return;
            }
            for (var i = 0; i < n; i++) {
                elem.copy(dst[dstOffset + i], src[srcOffset + i]);
            }
            return;
    }

    if (dst === src && dstOffset > srcOffset) {
        for (var i = n - 1; i >= 0; i--) {
            dst[dstOffset + i] = src[srcOffset + i];
        }
        return;
    }
    for (var i = 0; i < n; i++) {
        dst[dstOffset + i] = src[srcOffset + i];
    }
};

var $clone = (src, type) => {
    var clone = type.zero();
    type.copy(clone, src);
    return clone;
};

var $pointerOfStructConversion = (obj, type) => {
    if (obj.$proxies === undefined) {
        obj.$proxies = {};
        obj.$proxies[obj.constructor.string] = obj;
    }
    var proxy = obj.$proxies[type.string];
    if (proxy === undefined) {
        var properties = {};
        for (var i = 0; i < type.elem.fields.length; i++) {
            (fieldProp => {
                properties[fieldProp] = {
                    get() { return obj[fieldProp]; },
                    set(value) { obj[fieldProp] = value; }
                };
            })(type.elem.fields[i].prop);
        }
        proxy = Object.create(type.prototype, properties);
        proxy.$val = proxy;
        obj.$proxies[type.string] = proxy;
        proxy.$proxies = obj.$proxies;
    }
    return proxy;
};

var $append = function (slice) {
    return $internalAppend(slice, arguments, 1, arguments.length - 1);
};

var $appendSlice = (slice, toAppend) => {
    if (toAppend.constructor === String) {
        var bytes = $stringToBytes(toAppend);
        return $internalAppend(slice, bytes, 0, bytes.length);
    }
    return $internalAppend(slice, toAppend.$array, toAppend.$offset, toAppend.$length);
};

var $internalAppend = (slice, array, offset, length) => {
    if (length === 0) {
        return slice;
    }

    var newArray = slice.$array;
    var newOffset = slice.$offset;
    var newLength = slice.$length + length;
    var newCapacity = slice.$capacity;

    if (newLength > newCapacity) {
        newOffset = 0;
        newCapacity = Math.max(newLength, slice.$capacity < 1024 ? slice.$capacity * 2 : Math.floor(slice.$capacity * 5 / 4));

        if (slice.$array.constructor === Array) {
            newArray = slice.$array.slice(slice.$offset, slice.$offset + slice.$length);
            newArray.length = newCapacity;
            var zero = slice.constructor.elem.zero;
            for (var i = slice.$length; i < newCapacity; i++) {
                newArray[i] = zero();
            }
        } else {
            newArray = new slice.$array.constructor(newCapacity);
            newArray.set(slice.$array.subarray(slice.$offset, slice.$offset + slice.$length));
        }
    }

    $copyArray(newArray, array, newOffset + slice.$length, offset, length, slice.constructor.elem);

    var newSlice = new slice.constructor(newArray);
    newSlice.$offset = newOffset;
    newSlice.$length = newLength;
    newSlice.$capacity = newCapacity;
    return newSlice;
};

var $equal = (a, b, type) => {
    if (type === $jsObjectPtr) {
        return a === b;
    }
    switch (type.kind) {
        case $kindComplex64:
        case $kindComplex128:
            return a.$real === b.$real && a.$imag === b.$imag;
        case $kindInt64:
        case $kindUint64:
            return a.$high === b.$high && a.$low === b.$low;
        case $kindArray:
            if (a.length !== b.length) {
                return false;
            }
            for (var i = 0; i < a.length; i++) {
                if (!$equal(a[i], b[i], type.elem)) {
                    return false;
                }
            }
            return true;
        case $kindStruct:
            for (var i = 0; i < type.fields.length; i++) {
                var f = type.fields[i];
                if (!$equal(a[f.prop], b[f.prop], f.typ)) {
                    return false;
                }
            }
            return true;
        case $kindInterface:
            return $interfaceIsEqual(a, b);
        default:
            return a === b;
    }
};

var $interfaceIsEqual = (a, b) => {
    if (a === $ifaceNil || b === $ifaceNil) {
        return a === b;
    }
    if (a.constructor !== b.constructor) {
        return false;
    }
    if (a.constructor === $jsObjectPtr) {
        return a.object === b.object;
    }
    if (!a.constructor.comparable) {
        $throwRuntimeError("comparing uncomparable type " + a.constructor.string);
    }
    return $equal(a.$val, b.$val, a.constructor);
};

var $unsafeMethodToFunction = (typ, name, isPtr) => {
    if (isPtr) {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $pointerOfStructConversion(r, ptrType);
                        break;
                    case $kindArray:
                        r = new ptrType(r);
                        break;
                    default:
                        r = new ptrType(r.$get, r.$set, r.$target);
                }
            }
            return r[name](...args);
        };
    } else {
        return (r, ...args) => {
            var ptrType = $ptrType(typ);
            if (r.constructor != ptrType) {
                switch (typ.kind) {
                    case $kindStruct:
                        r = $clone(r, typ);
                        break;
                    case $kindSlice:
                        r = $convertSliceType(r, typ);
                        break;
                    case $kindComplex64:
                    case $kindComplex128:
                        r = new typ(r.$real, r.$imag);
                        break;
                    default:
                        r = new typ(r);
                }
            }
            return r[name](...args);
        };
    }
};

var $id = x => {
    return x;
};

var $instanceOf = (x, y) => {
    return x instanceof y;
};

var $typeOf = x => {
    return typeof (x);
};
var $min = Math.min;
var $mod = (x, y) => { return x % y; };
var $parseInt = parseInt;
var $parseFloat = f => {
    if (f !== undefined && f !== null && f.constructor === Number) {
        return f;
    }
    return parseFloat(f);
};

var $froundBuf = new Float32Array(1);
var $fround = Math.fround || (f => {
    $froundBuf[0] = f;
    return $froundBuf[0];
});

var $imul = Math.imul || ((a, b) => {
    var ah = (a >>> 16) & 0xffff;
    var al = a & 0xffff;
    var bh = (b >>> 16) & 0xffff;
    var bl = b & 0xffff;
    return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0) >> 0);
});

var $floatKey = f => {
    if (f !== f) {
        $idCounter++;
        return "NaN$" + $idCounter;
    }
    return String(f);
};

var $flatten64 = x => {
    return x.$high * 4294967296 + x.$low;
};

var $shiftLeft64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high << y | x.$low >>> (32 - y), (x.$low << y) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$low << (y - 32), 0);
    }
    return new x.constructor(0, 0);
};

var $shiftRightInt64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(x.$high >> 31, (x.$high >> (y - 32)) >>> 0);
    }
    if (x.$high < 0) {
        return new x.constructor(-1, 4294967295);
    }
    return new x.constructor(0, 0);
};

var $shiftRightUint64 = (x, y) => {
    if (y === 0) {
        return x;
    }
    if (y < 32) {
        return new x.constructor(x.$high >>> y, (x.$low >>> y | x.$high << (32 - y)) >>> 0);
    }
    if (y < 64) {
        return new x.constructor(0, x.$high >>> (y - 32));
    }
    return new x.constructor(0, 0);
};

var $mul64 = (x, y) => {
    var x48 = x.$high >>> 16;
    var x32 = x.$high & 0xFFFF;
    var x16 = x.$low >>> 16;
    var x00 = x.$low & 0xFFFF;

    var y48 = y.$high >>> 16;
    var y32 = y.$high & 0xFFFF;
    var y16 = y.$low >>> 16;
    var y00 = y.$low & 0xFFFF;

    var z48 = 0, z32 = 0, z16 = 0, z00 = 0;
    z00 += x00 * y00;
    z16 += z00 >>> 16;
    z00 &= 0xFFFF;
    z16 += x16 * y00;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z16 += x00 * y16;
    z32 += z16 >>> 16;
    z16 &= 0xFFFF;
    z32 += x32 * y00;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x16 * y16;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z32 += x00 * y32;
    z48 += z32 >>> 16;
    z32 &= 0xFFFF;
    z48 += x48 * y00 + x32 * y16 + x16 * y32 + x00 * y48;
    z48 &= 0xFFFF;

    var hi = ((z48 << 16) | z32) >>> 0;
    var lo = ((z16 << 16) | z00) >>> 0;

    var r = new x.constructor(hi, lo);
    return r;
};

var $div64 = (x, y, returnRemainder) => {
    if (y.$high === 0 && y.$low === 0) {
        $throwRuntimeError("integer divide by zero");
    }

    var s = 1;
    var rs = 1;

    var xHigh = x.$high;
    var xLow = x.$low;
    if (xHigh < 0) {
        s = -1;
        rs = -1;
        xHigh = -xHigh;
        if (xLow !== 0) {
            xHigh--;
            xLow = 4294967296 - xLow;
        }
    }

    var yHigh = y.$high;
    var yLow = y.$low;
    if (y.$high < 0) {
        s *= -1;
        yHigh = -yHigh;
        if (yLow !== 0) {
            yHigh--;
            yLow = 4294967296 - yLow;
        }
    }

    var high = 0, low = 0, n = 0;
    while (yHigh < 2147483648 && ((xHigh > yHigh) || (xHigh === yHigh && xLow > yLow))) {
        yHigh = (yHigh << 1 | yLow >>> 31) >>> 0;
        yLow = (yLow << 1) >>> 0;
        n++;
    }
    for (var i = 0; i <= n; i++) {
        high = high << 1 | low >>> 31;
        low = (low << 1) >>> 0;
        if ((xHigh > yHigh) || (xHigh === yHigh && xLow >= yLow)) {
            xHigh = xHigh - yHigh;
            xLow = xLow - yLow;
            if (xLow < 0) {
                xHigh--;
                xLow += 4294967296;
            }
            low++;
            if (low === 4294967296) {
                high++;
                low = 0;
            }
        }
        yLow = (yLow >>> 1 | yHigh << (32 - 1)) >>> 0;
        yHigh = yHigh >>> 1;
    }

    if (returnRemainder) {
        return new x.constructor(xHigh * rs, xLow * rs);
    }
    return new x.constructor(high * s, low * s);
};

var $divComplex = (n, d) => {
    var ninf = n.$real === Infinity || n.$real === -Infinity || n.$imag === Infinity || n.$imag === -Infinity;
    var dinf = d.$real === Infinity || d.$real === -Infinity || d.$imag === Infinity || d.$imag === -Infinity;
    var nnan = !ninf && (n.$real !== n.$real || n.$imag !== n.$imag);
    var dnan = !dinf && (d.$real !== d.$real || d.$imag !== d.$imag);
    if (nnan || dnan) {
        return new n.constructor(NaN, NaN);
    }
    if (ninf && !dinf) {
        return new n.constructor(Infinity, Infinity);
    }
    if (!ninf && dinf) {
        return new n.constructor(0, 0);
    }
    if (d.$real === 0 && d.$imag === 0) {
        if (n.$real === 0 && n.$imag === 0) {
            return new n.constructor(NaN, NaN);
        }
        return new n.constructor(Infinity, Infinity);
    }
    var a = Math.abs(d.$real);
    var b = Math.abs(d.$imag);
    if (a <= b) {
        var ratio = d.$real / d.$imag;
        var denom = d.$real * ratio + d.$imag;
        return new n.constructor((n.$real * ratio + n.$imag) / denom, (n.$imag * ratio - n.$real) / denom);
    }
    var ratio = d.$imag / d.$real;
    var denom = d.$imag * ratio + d.$real;
    return new n.constructor((n.$imag * ratio + n.$real) / denom, (n.$imag - n.$real * ratio) / denom);
};
var $kindBool = 1;
var $kindInt = 2;
var $kindInt8 = 3;
var $kindInt16 = 4;
var $kindInt32 = 5;
var $kindInt64 = 6;
var $kindUint = 7;
var $kindUint8 = 8;
var $kindUint16 = 9;
var $kindUint32 = 10;
var $kindUint64 = 11;
var $kindUintptr = 12;
var $kindFloat32 = 13;
var $kindFloat64 = 14;
var $kindComplex64 = 15;
var $kindComplex128 = 16;
var $kindArray = 17;
var $kindChan = 18;
var $kindFunc = 19;
var $kindInterface = 20;
var $kindMap = 21;
var $kindPtr = 22;
var $kindSlice = 23;
var $kindString = 24;
var $kindStruct = 25;
var $kindUnsafePointer = 26;

var $methodSynthesizers = [];
var $addMethodSynthesizer = f => {
    if ($methodSynthesizers === null) {
        f();
        return;
    }
    $methodSynthesizers.push(f);
};
var $synthesizeMethods = () => {
    $methodSynthesizers.forEach(f => { f(); });
    $methodSynthesizers = null;
};

var $ifaceKeyFor = x => {
    if (x === $ifaceNil) {
        return 'nil';
    }
    var c = x.constructor;
    return c.string + '$' + c.keyFor(x.$val);
};

var $identity = x => { return x; };

var $typeIDCounter = 0;

var $idKey = x => {
    if (x.$id === undefined) {
        $idCounter++;
        x.$id = $idCounter;
    }
    return String(x.$id);
};

// Creates constructor functions for array pointer types. Returns a new function
// instace each time to make sure each type is independent of the other.
var $arrayPtrCtor = () => {
    return function (array) {
        this.$get = () => { return array; };
        this.$set = function (v) { typ.copy(this, v); };
        this.$val = array;
    };
}

var $newType = (size, kind, string, named, pkg, exported, constructor) => {
    var typ;
    switch (kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $identity;
            break;

        case $kindString:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return "$" + x; };
            break;

        case $kindFloat32:
        case $kindFloat64:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = x => { return $floatKey(x); };
            break;

        case $kindInt64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindUint64:
            typ = function (high, low) {
                this.$high = (high + Math.floor(Math.ceil(low) / 4294967296)) >>> 0;
                this.$low = low >>> 0;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$high + "$" + x.$low; };
            break;

        case $kindComplex64:
            typ = function (real, imag) {
                this.$real = $fround(real);
                this.$imag = $fround(imag);
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindComplex128:
            typ = function (real, imag) {
                this.$real = real;
                this.$imag = imag;
                this.$val = this;
            };
            typ.keyFor = x => { return x.$real + "$" + x.$imag; };
            break;

        case $kindArray:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, "", false, $arrayPtrCtor());
            typ.init = (elem, len) => {
                typ.elem = elem;
                typ.len = len;
                typ.comparable = elem.comparable;
                typ.keyFor = x => {
                    return Array.prototype.join.call($mapArray(x, e => {
                        return String(elem.keyFor(e)).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }), "$");
                };
                typ.copy = (dst, src) => {
                    $copyArray(dst, src, 0, 0, src.length, elem);
                };
                typ.ptr.init(typ);
                Object.defineProperty(typ.ptr.nil, "nilCheck", { get: $throwNilPointerError });
            };
            break;

        case $kindChan:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.keyFor = $idKey;
            typ.init = (elem, sendOnly, recvOnly) => {
                typ.elem = elem;
                typ.sendOnly = sendOnly;
                typ.recvOnly = recvOnly;
            };
            break;

        case $kindFunc:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (params, results, variadic) => {
                typ.params = params;
                typ.results = results;
                typ.variadic = variadic;
                typ.comparable = false;
            };
            break;

        case $kindInterface:
            typ = { implementedBy: {}, missingMethodFor: {} };
            typ.keyFor = $ifaceKeyFor;
            typ.init = methods => {
                typ.methods = methods;
                methods.forEach(m => {
                    $ifaceNil[m.prop] = $throwNilPointerError;
                });
            };
            break;

        case $kindMap:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.init = (key, elem) => {
                typ.key = key;
                typ.elem = elem;
                typ.comparable = false;
            };
            break;

        case $kindPtr:
            typ = constructor || function (getter, setter, target) {
                this.$get = getter;
                this.$set = setter;
                this.$target = target;
                this.$val = this;
            };
            typ.keyFor = $idKey;
            typ.init = elem => {
                typ.elem = elem;
                typ.wrapped = (elem.kind === $kindArray);
                typ.nil = new typ($throwNilPointerError, $throwNilPointerError);
            };
            break;

        case $kindSlice:
            typ = function (array) {
                if (array.constructor !== typ.nativeArray) {
                    array = new typ.nativeArray(array);
                }
                this.$array = array;
                this.$offset = 0;
                this.$length = array.length;
                this.$capacity = array.length;
                this.$val = this;
            };
            typ.init = elem => {
                typ.elem = elem;
                typ.comparable = false;
                typ.nativeArray = $nativeArray(elem.kind);
                typ.nil = new typ([]);
            };
            break;

        case $kindStruct:
            typ = function (v) { this.$val = v; };
            typ.wrapped = true;
            typ.ptr = $newType(4, $kindPtr, "*" + string, false, pkg, exported, constructor);
            typ.ptr.elem = typ;
            typ.ptr.prototype.$get = function () { return this; };
            typ.ptr.prototype.$set = function (v) { typ.copy(this, v); };
            typ.init = (pkgPath, fields) => {
                typ.pkgPath = pkgPath;
                typ.fields = fields;
                fields.forEach(f => {
                    if (!f.typ.comparable) {
                        typ.comparable = false;
                    }
                });
                typ.keyFor = x => {
                    var val = x.$val;
                    return $mapArray(fields, f => {
                        return String(f.typ.keyFor(val[f.prop])).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
                    }).join("$");
                };
                typ.copy = (dst, src) => {
                    for (var i = 0; i < fields.length; i++) {
                        var f = fields[i];
                        switch (f.typ.kind) {
                            case $kindArray:
                            case $kindStruct:
                                f.typ.copy(dst[f.prop], src[f.prop]);
                                continue;
                            default:
                                dst[f.prop] = src[f.prop];
                                continue;
                        }
                    }
                };
                /* nil value */
                var properties = {};
                fields.forEach(f => {
                    properties[f.prop] = { get: $throwNilPointerError, set: $throwNilPointerError };
                });
                typ.ptr.nil = Object.create(constructor.prototype, properties);
                typ.ptr.nil.$val = typ.ptr.nil;
                /* methods for embedded fields */
                $addMethodSynthesizer(() => {
                    var synthesizeMethod = (target, m, f) => {
                        if (target.prototype[m.prop] !== undefined) { return; }
                        target.prototype[m.prop] = function(...args) {
                            var v = this.$val[f.prop];
                            if (f.typ === $jsObjectPtr) {
                                v = new $jsObjectPtr(v);
                            }
                            if (v.$val === undefined) {
                                v = new f.typ(v);
                            }
                            return v[m.prop](...args);
                        };
                    };
                    fields.forEach(f => {
                        if (f.embedded) {
                            $methodSet(f.typ).forEach(m => {
                                synthesizeMethod(typ, m, f);
                                synthesizeMethod(typ.ptr, m, f);
                            });
                            $methodSet($ptrType(f.typ)).forEach(m => {
                                synthesizeMethod(typ.ptr, m, f);
                            });
                        }
                    });
                });
            };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    switch (kind) {
        case $kindBool:
        case $kindMap:
            typ.zero = () => { return false; };
            break;

        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindUnsafePointer:
        case $kindFloat32:
        case $kindFloat64:
            typ.zero = () => { return 0; };
            break;

        case $kindString:
            typ.zero = () => { return ""; };
            break;

        case $kindInt64:
        case $kindUint64:
        case $kindComplex64:
        case $kindComplex128:
            var zero = new typ(0, 0);
            typ.zero = () => { return zero; };
            break;

        case $kindPtr:
        case $kindSlice:
            typ.zero = () => { return typ.nil; };
            break;

        case $kindChan:
            typ.zero = () => { return $chanNil; };
            break;

        case $kindFunc:
            typ.zero = () => { return $throwNilPointerError; };
            break;

        case $kindInterface:
            typ.zero = () => { return $ifaceNil; };
            break;

        case $kindArray:
            typ.zero = () => {
                var arrayClass = $nativeArray(typ.elem.kind);
                if (arrayClass !== Array) {
                    return new arrayClass(typ.len);
                }
                var array = new Array(typ.len);
                for (var i = 0; i < typ.len; i++) {
                    array[i] = typ.elem.zero();
                }
                return array;
            };
            break;

        case $kindStruct:
            typ.zero = () => { return new typ.ptr(); };
            break;

        default:
            $panic(new $String("invalid kind: " + kind));
    }

    typ.id = $typeIDCounter;
    $typeIDCounter++;
    typ.size = size;
    typ.kind = kind;
    typ.string = string;
    typ.named = named;
    typ.pkg = pkg;
    typ.exported = exported;
    typ.methods = [];
    typ.methodSetCache = null;
    typ.comparable = true;
    return typ;
};

var $methodSet = typ => {
    if (typ.methodSetCache !== null) {
        return typ.methodSetCache;
    }
    var base = {};

    var isPtr = (typ.kind === $kindPtr);
    if (isPtr && typ.elem.kind === $kindInterface) {
        typ.methodSetCache = [];
        return [];
    }

    var current = [{ typ: isPtr ? typ.elem : typ, indirect: isPtr }];

    var seen = {};

    while (current.length > 0) {
        var next = [];
        var mset = [];

        current.forEach(e => {
            if (seen[e.typ.string]) {
                return;
            }
            seen[e.typ.string] = true;

            if (e.typ.named) {
                mset = mset.concat(e.typ.methods);
                if (e.indirect) {
                    mset = mset.concat($ptrType(e.typ).methods);
                }
            }

            switch (e.typ.kind) {
                case $kindStruct:
                    e.typ.fields.forEach(f => {
                        if (f.embedded) {
                            var fTyp = f.typ;
                            var fIsPtr = (fTyp.kind === $kindPtr);
                            next.push({ typ: fIsPtr ? fTyp.elem : fTyp, indirect: e.indirect || fIsPtr });
                        }
                    });
                    break;

                case $kindInterface:
                    mset = mset.concat(e.typ.methods);
                    break;
            }
        });

        mset.forEach(m => {
            if (base[m.name] === undefined) {
                base[m.name] = m;
            }
        });

        current = next;
    }

    typ.methodSetCache = [];
    Object.keys(base).sort().forEach(name => {
        typ.methodSetCache.push(base[name]);
    });
    return typ.methodSetCache;
};

var $Bool = $newType(1, $kindBool, "bool", true, "", false, null);
var $Int = $newType(4, $kindInt, "int", true, "", false, null);
var $Int8 = $newType(1, $kindInt8, "int8", true, "", false, null);
var $Int16 = $newType(2, $kindInt16, "int16", true, "", false, null);
var $Int32 = $newType(4, $kindInt32, "int32", true, "", false, null);
var $Int64 = $newType(8, $kindInt64, "int64", true, "", false, null);
var $Uint = $newType(4, $kindUint, "uint", true, "", false, null);
var $Uint8 = $newType(1, $kindUint8, "uint8", true, "", false, null);
var $Uint16 = $newType(2, $kindUint16, "uint16", true, "", false, null);
var $Uint32 = $newType(4, $kindUint32, "uint32", true, "", false, null);
var $Uint64 = $newType(8, $kindUint64, "uint64", true, "", false, null);
var $Uintptr = $newType(4, $kindUintptr, "uintptr", true, "", false, null);
var $Float32 = $newType(4, $kindFloat32, "float32", true, "", false, null);
var $Float64 = $newType(8, $kindFloat64, "float64", true, "", false, null);
var $Complex64 = $newType(8, $kindComplex64, "complex64", true, "", false, null);
var $Complex128 = $newType(16, $kindComplex128, "complex128", true, "", false, null);
var $String = $newType(8, $kindString, "string", true, "", false, null);
var $UnsafePointer = $newType(4, $kindUnsafePointer, "unsafe.Pointer", true, "unsafe", false, null);

var $nativeArray = elemKind => {
    switch (elemKind) {
        case $kindInt:
            return Int32Array;
        case $kindInt8:
            return Int8Array;
        case $kindInt16:
            return Int16Array;
        case $kindInt32:
            return Int32Array;
        case $kindUint:
            return Uint32Array;
        case $kindUint8:
            return Uint8Array;
        case $kindUint16:
            return Uint16Array;
        case $kindUint32:
            return Uint32Array;
        case $kindUintptr:
            return Uint32Array;
        case $kindFloat32:
            return Float32Array;
        case $kindFloat64:
            return Float64Array;
        default:
            return Array;
    }
};
var $toNativeArray = (elemKind, array) => {
    var nativeArray = $nativeArray(elemKind);
    if (nativeArray === Array) {
        return array;
    }
    return new nativeArray(array);
};
var $arrayTypes = {};
var $arrayType = (elem, len) => {
    var typeKey = elem.id + "$" + len;
    var typ = $arrayTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(elem.size * len, $kindArray, "[" + len + "]" + elem.string, false, "", false, null);
        $arrayTypes[typeKey] = typ;
        typ.init(elem, len);
    }
    return typ;
};

var $chanType = (elem, sendOnly, recvOnly) => {
    var string = (recvOnly ? "<-" : "") + "chan" + (sendOnly ? "<- " : " ");
    if (!sendOnly && !recvOnly && (elem.string[0] == "<")) {
        string += "(" + elem.string + ")";
    } else {
        string += elem.string;
    }
    var field = sendOnly ? "SendChan" : (recvOnly ? "RecvChan" : "Chan");
    var typ = elem[field];
    if (typ === undefined) {
        typ = $newType(4, $kindChan, string, false, "", false, null);
        elem[field] = typ;
        typ.init(elem, sendOnly, recvOnly);
    }
    return typ;
};
var $Chan = function (elem, capacity) {
    if (capacity < 0 || capacity > 2147483647) {
        $throwRuntimeError("makechan: size out of range");
    }
    this.$elem = elem;
    this.$capacity = capacity;
    this.$buffer = [];
    this.$sendQueue = [];
    this.$recvQueue = [];
    this.$closed = false;
};
var $chanNil = new $Chan(null, 0);
$chanNil.$sendQueue = $chanNil.$recvQueue = { length: 0, push() { }, shift() { return undefined; }, indexOf() { return -1; } };

var $funcTypes = {};
var $funcType = (params, results, variadic) => {
    var typeKey = $mapArray(params, p => { return p.id; }).join(",") + "$" + $mapArray(results, r => { return r.id; }).join(",") + "$" + variadic;
    var typ = $funcTypes[typeKey];
    if (typ === undefined) {
        var paramTypes = $mapArray(params, p => { return p.string; });
        if (variadic) {
            paramTypes[paramTypes.length - 1] = "..." + paramTypes[paramTypes.length - 1].substr(2);
        }
        var string = "func(" + paramTypes.join(", ") + ")";
        if (results.length === 1) {
            string += " " + results[0].string;
        } else if (results.length > 1) {
            string += " (" + $mapArray(results, r => { return r.string; }).join(", ") + ")";
        }
        typ = $newType(4, $kindFunc, string, false, "", false, null);
        $funcTypes[typeKey] = typ;
        typ.init(params, results, variadic);
    }
    return typ;
};

var $interfaceTypes = {};
var $interfaceType = methods => {
    var typeKey = $mapArray(methods, m => { return m.pkg + "," + m.name + "," + m.typ.id; }).join("$");
    var typ = $interfaceTypes[typeKey];
    if (typ === undefined) {
        var string = "interface {}";
        if (methods.length !== 0) {
            string = "interface { " + $mapArray(methods, m => {
                return (m.pkg !== "" ? m.pkg + "." : "") + m.name + m.typ.string.substr(4);
            }).join("; ") + " }";
        }
        typ = $newType(8, $kindInterface, string, false, "", false, null);
        $interfaceTypes[typeKey] = typ;
        typ.init(methods);
    }
    return typ;
};
var $emptyInterface = $interfaceType([]);
var $ifaceNil = {};
var $error = $newType(8, $kindInterface, "error", true, "", false, null);
$error.init([{ prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false) }]);

var $mapTypes = {};
var $mapType = (key, elem) => {
    var typeKey = key.id + "$" + elem.id;
    var typ = $mapTypes[typeKey];
    if (typ === undefined) {
        typ = $newType(4, $kindMap, "map[" + key.string + "]" + elem.string, false, "", false, null);
        $mapTypes[typeKey] = typ;
        typ.init(key, elem);
    }
    return typ;
};
var $makeMap = (keyForFunc, entries) => {
    var m = new Map();
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        m.set(keyForFunc(e.k), e);
    }
    return m;
};

var $ptrType = elem => {
    var typ = elem.ptr;
    if (typ === undefined) {
        typ = $newType(4, $kindPtr, "*" + elem.string, false, "", elem.exported, null);
        elem.ptr = typ;
        typ.init(elem);
    }
    return typ;
};

var $newDataPointer = (data, constructor) => {
    if (constructor.elem.kind === $kindStruct) {
        return data;
    }
    return new constructor(() => { return data; }, v => { data = v; });
};

var $indexPtr = (array, index, constructor) => {
    if (array.buffer) {
        // Pointers to the same underlying ArrayBuffer share cache.
        var cache = array.buffer.$ptr = array.buffer.$ptr || {};
        // Pointers of different primitive types are non-comparable and stored in different caches.
        var typeCache = cache[array.name] = cache[array.name] || {};
        var cacheIdx = array.BYTES_PER_ELEMENT * index + array.byteOffset;
        return typeCache[cacheIdx] || (typeCache[cacheIdx] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    } else {
        array.$ptr = array.$ptr || {};
        return array.$ptr[index] || (array.$ptr[index] = new constructor(() => { return array[index]; }, v => { array[index] = v; }));
    }
};

var $sliceType = elem => {
    var typ = elem.slice;
    if (typ === undefined) {
        typ = $newType(12, $kindSlice, "[]" + elem.string, false, "", false, null);
        elem.slice = typ;
        typ.init(elem);
    }
    return typ;
};
var $makeSlice = (typ, length, capacity = length) => {
    if (length < 0 || length > 2147483647) {
        $throwRuntimeError("makeslice: len out of range");
    }
    if (capacity < 0 || capacity < length || capacity > 2147483647) {
        $throwRuntimeError("makeslice: cap out of range");
    }
    var array = new typ.nativeArray(capacity);
    if (typ.nativeArray === Array) {
        for (var i = 0; i < capacity; i++) {
            array[i] = typ.elem.zero();
        }
    }
    var slice = new typ(array);
    slice.$length = length;
    return slice;
};

var $structTypes = {};
var $structType = (pkgPath, fields) => {
    var typeKey = $mapArray(fields, f => { return f.name + "," + f.typ.id + "," + f.tag; }).join("$");
    var typ = $structTypes[typeKey];
    if (typ === undefined) {
        var string = "struct { " + $mapArray(fields, f => {
            var str = f.typ.string + (f.tag !== "" ? (" \"" + f.tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"") : "");
            if (f.embedded) {
                return str;
            }
            return f.name + " " + str;
        }).join("; ") + " }";
        if (fields.length === 0) {
            string = "struct {}";
        }
        typ = $newType(0, $kindStruct, string, false, "", false, function(...args) {
            this.$val = this;
            for (var i = 0; i < fields.length; i++) {
                var f = fields[i];
                if (f.name == '_') {
                    continue;
                }
                var arg = args[i];
                this[f.prop] = arg !== undefined ? arg : f.typ.zero();
            }
        });
        $structTypes[typeKey] = typ;
        typ.init(pkgPath, fields);
    }
    return typ;
};

var $assertType = (value, type, returnTuple) => {
    var isInterface = (type.kind === $kindInterface), ok, missingMethod = "";
    if (value === $ifaceNil) {
        ok = false;
    } else if (!isInterface) {
        ok = value.constructor === type;
    } else {
        var valueTypeString = value.constructor.string;
        ok = type.implementedBy[valueTypeString];
        if (ok === undefined) {
            ok = true;
            var valueMethodSet = $methodSet(value.constructor);
            var interfaceMethods = type.methods;
            for (var i = 0; i < interfaceMethods.length; i++) {
                var tm = interfaceMethods[i];
                var found = false;
                for (var j = 0; j < valueMethodSet.length; j++) {
                    var vm = valueMethodSet[j];
                    if (vm.name === tm.name && vm.pkg === tm.pkg && vm.typ === tm.typ) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    ok = false;
                    type.missingMethodFor[valueTypeString] = tm.name;
                    break;
                }
            }
            type.implementedBy[valueTypeString] = ok;
        }
        if (!ok) {
            missingMethod = type.missingMethodFor[valueTypeString];
        }
    }

    if (!ok) {
        if (returnTuple) {
            return [type.zero(), false];
        }
        $panic(new $packages["runtime"].TypeAssertionError.ptr(
            $packages["runtime"]._type.ptr.nil,
            (value === $ifaceNil ? $packages["runtime"]._type.ptr.nil : new $packages["runtime"]._type.ptr(value.constructor.string)),
            new $packages["runtime"]._type.ptr(type.string),
            missingMethod));
    }

    if (!isInterface) {
        value = value.$val;
    }
    if (type === $jsObjectPtr) {
        value = value.object;
    }
    return returnTuple ? [value, true] : value;
};
var $stackDepthOffset = 0;
var $getStackDepth = () => {
    var err = new Error();
    if (err.stack === undefined) {
        return undefined;
    }
    return $stackDepthOffset + err.stack.split("\n").length;
};

var $panicStackDepth = null, $panicValue;
var $callDeferred = (deferred, jsErr, fromPanic) => {
    if (!fromPanic && deferred !== null && $curGoroutine.deferStack.indexOf(deferred) == -1) {
        throw jsErr;
    }
    if (jsErr !== null) {
        var newErr = null;
        try {
            $panic(new $jsErrorPtr(jsErr));
        } catch (err) {
            newErr = err;
        }
        $callDeferred(deferred, newErr);
        return;
    }
    if ($curGoroutine.asleep) {
        return;
    }

    $stackDepthOffset--;
    var outerPanicStackDepth = $panicStackDepth;
    var outerPanicValue = $panicValue;

    var localPanicValue = $curGoroutine.panicStack.pop();
    if (localPanicValue !== undefined) {
        $panicStackDepth = $getStackDepth();
        $panicValue = localPanicValue;
    }

    try {
        while (true) {
            if (deferred === null) {
                deferred = $curGoroutine.deferStack[$curGoroutine.deferStack.length - 1];
                if (deferred === undefined) {
                    /* The panic reached the top of the stack. Clear it and throw it as a JavaScript error. */
                    $panicStackDepth = null;
                    if (localPanicValue.Object instanceof Error) {
                        throw localPanicValue.Object;
                    }
                    var msg;
                    if (localPanicValue.constructor === $String) {
                        msg = localPanicValue.$val;
                    } else if (localPanicValue.Error !== undefined) {
                        msg = localPanicValue.Error();
                    } else if (localPanicValue.String !== undefined) {
                        msg = localPanicValue.String();
                    } else {
                        msg = localPanicValue;
                    }
                    throw new Error(msg);
                }
            }
            var call = deferred.pop();
            if (call === undefined) {
                $curGoroutine.deferStack.pop();
                if (localPanicValue !== undefined) {
                    deferred = null;
                    continue;
                }
                return;
            }
            var r = call[0].apply(call[2], call[1]);
            if (r && r.$blk !== undefined) {
                deferred.push([r.$blk, [], r]);
                if (fromPanic) {
                    throw null;
                }
                return;
            }

            if (localPanicValue !== undefined && $panicStackDepth === null) {
                /* error was recovered */
                if (fromPanic) {
                    throw null;
                }
                return;
            }
        }
    } catch (e) {
        // Deferred function threw a JavaScript exception or tries to unwind stack
        // to the point where a panic was handled.
        if (fromPanic) {
            // Re-throw the exception to reach deferral execution call at the end
            // of the function.
            throw e;
        }
        // We are at the end of the function, handle the error or re-throw to
        // continue unwinding if necessary, or simply stop unwinding if we got far
        // enough.
        $callDeferred(deferred, e, fromPanic);
    } finally {
        if (localPanicValue !== undefined) {
            if ($panicStackDepth !== null) {
                $curGoroutine.panicStack.push(localPanicValue);
            }
            $panicStackDepth = outerPanicStackDepth;
            $panicValue = outerPanicValue;
        }
        $stackDepthOffset++;
    }
};

var $panic = value => {
    $curGoroutine.panicStack.push(value);
    $callDeferred(null, null, true);
};
var $recover = () => {
    if ($panicStackDepth === null || ($panicStackDepth !== undefined && $panicStackDepth !== $getStackDepth() - 2)) {
        return $ifaceNil;
    }
    $panicStackDepth = null;
    return $panicValue;
};
var $throw = err => { throw err; };

var $noGoroutine = { asleep: false, exit: false, deferStack: [], panicStack: [] };
var $curGoroutine = $noGoroutine, $totalGoroutines = 0, $awakeGoroutines = 0, $checkForDeadlock = true, $exportedFunctions = 0;
var $mainFinished = false;
var $go = (fun, args) => {
    $totalGoroutines++;
    $awakeGoroutines++;
    var $goroutine = () => {
        try {
            $curGoroutine = $goroutine;
            var r = fun(...args);
            if (r && r.$blk !== undefined) {
                fun = () => { return r.$blk(); };
                args = [];
                return;
            }
            $goroutine.exit = true;
        } catch (err) {
            if (!$goroutine.exit) {
                throw err;
            }
        } finally {
            $curGoroutine = $noGoroutine;
            if ($goroutine.exit) { /* also set by runtime.Goexit() */
                $totalGoroutines--;
                $goroutine.asleep = true;
            }
            if ($goroutine.asleep) {
                $awakeGoroutines--;
                if (!$mainFinished && $awakeGoroutines === 0 && $checkForDeadlock && $exportedFunctions === 0) {
                    console.error("fatal error: all goroutines are asleep - deadlock!");
                    if ($global.process !== undefined) {
                        $global.process.exit(2);
                    }
                }
            }
        }
    };
    $goroutine.asleep = false;
    $goroutine.exit = false;
    $goroutine.deferStack = [];
    $goroutine.panicStack = [];
    $schedule($goroutine);
};

var $scheduled = [];
var $runScheduled = () => {
    // For nested setTimeout calls browsers enforce 4ms minimum delay. We minimize
    // the effect of this penalty by queueing the timer preemptively before we run
    // the goroutines, and later cancelling it if it turns out unneeded. See:
    // https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#nested_timeouts
    var nextRun = setTimeout($runScheduled);
    try {
        var start = Date.now();
        var r;
        while ((r = $scheduled.shift()) !== undefined) {
            r();
            // We need to interrupt this loop in order to allow the event loop to
            // process timers, IO, etc. However, invoking scheduling through
            // setTimeout is ~1000 times more expensive, so we amortize this cost by
            // looping until the 4ms minimal delay has elapsed (assuming there are
            // scheduled goroutines to run), and then yield to the event loop.
            var elapsed = Date.now() - start;
            if (elapsed > 4 || elapsed < 0) { break; }
        }
    } finally {
        if ($scheduled.length == 0) {
            // Cancel scheduling pass if there's nothing to run.
            clearTimeout(nextRun);
        }
    }
};

var $schedule = goroutine => {
    if (goroutine.asleep) {
        goroutine.asleep = false;
        $awakeGoroutines++;
    }
    $scheduled.push(goroutine);
    if ($curGoroutine === $noGoroutine) {
        $runScheduled();
    }
};

var $setTimeout = (f, t) => {
    $awakeGoroutines++;
    return setTimeout(() => {
        $awakeGoroutines--;
        f();
    }, t);
};

var $block = () => {
    if ($curGoroutine === $noGoroutine) {
        $throwRuntimeError("cannot block in JavaScript callback, fix by wrapping code in goroutine");
    }
    $curGoroutine.asleep = true;
};

var $restore = (context, params) => {
    if (context !== undefined && context.$blk !== undefined) {
        return context;
    }
    return params;
}

var $send = (chan, value) => {
    if (chan.$closed) {
        $throwRuntimeError("send on closed channel");
    }
    var queuedRecv = chan.$recvQueue.shift();
    if (queuedRecv !== undefined) {
        queuedRecv([value, true]);
        return;
    }
    if (chan.$buffer.length < chan.$capacity) {
        chan.$buffer.push(value);
        return;
    }

    var thisGoroutine = $curGoroutine;
    var closedDuringSend;
    chan.$sendQueue.push(closed => {
        closedDuringSend = closed;
        $schedule(thisGoroutine);
        return value;
    });
    $block();
    return {
        $blk() {
            if (closedDuringSend) {
                $throwRuntimeError("send on closed channel");
            }
        }
    };
};
var $recv = chan => {
    var queuedSend = chan.$sendQueue.shift();
    if (queuedSend !== undefined) {
        chan.$buffer.push(queuedSend(false));
    }
    var bufferedValue = chan.$buffer.shift();
    if (bufferedValue !== undefined) {
        return [bufferedValue, true];
    }
    if (chan.$closed) {
        return [chan.$elem.zero(), false];
    }

    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.value; } };
    var queueEntry = v => {
        f.value = v;
        $schedule(thisGoroutine);
    };
    chan.$recvQueue.push(queueEntry);
    $block();
    return f;
};
var $close = chan => {
    if (chan.$closed) {
        $throwRuntimeError("close of closed channel");
    }
    chan.$closed = true;
    while (true) {
        var queuedSend = chan.$sendQueue.shift();
        if (queuedSend === undefined) {
            break;
        }
        queuedSend(true); /* will panic */
    }
    while (true) {
        var queuedRecv = chan.$recvQueue.shift();
        if (queuedRecv === undefined) {
            break;
        }
        queuedRecv([chan.$elem.zero(), false]);
    }
};
var $select = comms => {
    var ready = [];
    var selection = -1;
    for (var i = 0; i < comms.length; i++) {
        var comm = comms[i];
        var chan = comm[0];
        switch (comm.length) {
            case 0: /* default */
                selection = i;
                break;
            case 1: /* recv */
                if (chan.$sendQueue.length !== 0 || chan.$buffer.length !== 0 || chan.$closed) {
                    ready.push(i);
                }
                break;
            case 2: /* send */
                if (chan.$closed) {
                    $throwRuntimeError("send on closed channel");
                }
                if (chan.$recvQueue.length !== 0 || chan.$buffer.length < chan.$capacity) {
                    ready.push(i);
                }
                break;
        }
    }

    if (ready.length !== 0) {
        selection = ready[Math.floor(Math.random() * ready.length)];
    }
    if (selection !== -1) {
        var comm = comms[selection];
        switch (comm.length) {
            case 0: /* default */
                return [selection];
            case 1: /* recv */
                return [selection, $recv(comm[0])];
            case 2: /* send */
                $send(comm[0], comm[1]);
                return [selection];
        }
    }

    var entries = [];
    var thisGoroutine = $curGoroutine;
    var f = { $blk() { return this.selection; } };
    var removeFromQueues = () => {
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var queue = entry[0];
            var index = queue.indexOf(entry[1]);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    };
    for (var i = 0; i < comms.length; i++) {
        (i => {
            var comm = comms[i];
            switch (comm.length) {
                case 1: /* recv */
                    var queueEntry = value => {
                        f.selection = [i, value];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                    };
                    entries.push([comm[0].$recvQueue, queueEntry]);
                    comm[0].$recvQueue.push(queueEntry);
                    break;
                case 2: /* send */
                    var queueEntry = () => {
                        if (comm[0].$closed) {
                            $throwRuntimeError("send on closed channel");
                        }
                        f.selection = [i];
                        removeFromQueues();
                        $schedule(thisGoroutine);
                        return comm[1];
                    };
                    entries.push([comm[0].$sendQueue, queueEntry]);
                    comm[0].$sendQueue.push(queueEntry);
                    break;
            }
        })(i);
    }
    $block();
    return f;
};
var $jsObjectPtr, $jsErrorPtr;

var $needsExternalization = t => {
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return false;
        default:
            return t !== $jsObjectPtr;
    }
};

var $externalize = (v, t, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    switch (t.kind) {
        case $kindBool:
        case $kindInt:
        case $kindInt8:
        case $kindInt16:
        case $kindInt32:
        case $kindUint:
        case $kindUint8:
        case $kindUint16:
        case $kindUint32:
        case $kindUintptr:
        case $kindFloat32:
        case $kindFloat64:
            return v;
        case $kindInt64:
        case $kindUint64:
            return $flatten64(v);
        case $kindArray:
            if ($needsExternalization(t.elem)) {
                return $mapArray(v, e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return v;
        case $kindFunc:
            return $externalizeFunction(v, t, false, makeWrapper);
        case $kindInterface:
            if (v === $ifaceNil) {
                return null;
            }
            if (v.constructor === $jsObjectPtr) {
                return v.$val.object;
            }
            return $externalize(v.$val, v.constructor, makeWrapper);
        case $kindMap:
            if (v.keys === undefined) {
                return null;
            }
            var m = {};
            var keys = Array.from(v.keys());
            for (var i = 0; i < keys.length; i++) {
                var entry = v.get(keys[i]);
                m[$externalize(entry.k, t.key, makeWrapper)] = $externalize(entry.v, t.elem, makeWrapper);
            }
            return m;
        case $kindPtr:
            if (v === t.nil) {
                return null;
            }
            return $externalize(v.$get(), t.elem, makeWrapper);
        case $kindSlice:
            if (v === v.constructor.nil) {
                return null;
            }
            if ($needsExternalization(t.elem)) {
                return $mapArray($sliceToNativeArray(v), e => { return $externalize(e, t.elem, makeWrapper); });
            }
            return $sliceToNativeArray(v);
        case $kindString:
            if ($isASCII(v)) {
                return v;
            }
            var s = "", r;
            for (var i = 0; i < v.length; i += r[1]) {
                r = $decodeRune(v, i);
                var c = r[0];
                if (c > 0xFFFF) {
                    var h = Math.floor((c - 0x10000) / 0x400) + 0xD800;
                    var l = (c - 0x10000) % 0x400 + 0xDC00;
                    s += String.fromCharCode(h, l);
                    continue;
                }
                s += String.fromCharCode(c);
            }
            return s;
        case $kindStruct:
            var timePkg = $packages["time"];
            if (timePkg !== undefined && v.constructor === timePkg.Time.ptr) {
                var milli = $div64(v.UnixNano(), new $Int64(0, 1000000));
                return new Date($flatten64(milli));
            }

            var noJsObject = {};
            var searchJsObject = (v, t) => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                switch (t.kind) {
                    case $kindPtr:
                        if (v === t.nil) {
                            return noJsObject;
                        }
                        return searchJsObject(v.$get(), t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        return searchJsObject(v[f.prop], f.typ);
                    case $kindInterface:
                        return searchJsObject(v.$val, v.constructor);
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(v, t);
            if (o !== noJsObject) {
                return o;
            }

            if (makeWrapper !== undefined) {
                return makeWrapper(v);
            }

            o = {};
            for (var i = 0; i < t.fields.length; i++) {
                var f = t.fields[i];
                if (!f.exported) {
                    continue;
                }
                o[f.name] = $externalize(v[f.prop], f.typ, makeWrapper);
            }
            return o;
    }
    $throwRuntimeError("cannot externalize " + t.string);
};

var $externalizeFunction = (v, t, passThis, makeWrapper) => {
    if (v === $throwNilPointerError) {
        return null;
    }
    if (v.$externalizeWrapper === undefined) {
        $checkForDeadlock = false;
        v.$externalizeWrapper = function () {
            var args = [];
            for (var i = 0; i < t.params.length; i++) {
                if (t.variadic && i === t.params.length - 1) {
                    var vt = t.params[i].elem, varargs = [];
                    for (var j = i; j < arguments.length; j++) {
                        varargs.push($internalize(arguments[j], vt, makeWrapper));
                    }
                    args.push(new (t.params[i])(varargs));
                    break;
                }
                args.push($internalize(arguments[i], t.params[i], makeWrapper));
            }
            var result = v.apply(passThis ? this : undefined, args);
            switch (t.results.length) {
                case 0:
                    return;
                case 1:
                    return $externalize($copyIfRequired(result, t.results[0]), t.results[0], makeWrapper);
                default:
                    for (var i = 0; i < t.results.length; i++) {
                        result[i] = $externalize($copyIfRequired(result[i], t.results[i]), t.results[i], makeWrapper);
                    }
                    return result;
            }
        };
    }
    return v.$externalizeWrapper;
};

var $internalize = (v, t, recv, seen, makeWrapper) => {
    if (t === $jsObjectPtr) {
        return v;
    }
    if (t === $jsObjectPtr.elem) {
        $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
    }
    if (v && v.__internal_object__ !== undefined) {
        return $assertType(v.__internal_object__, t, false);
    }
    var timePkg = $packages["time"];
    if (timePkg !== undefined && t === timePkg.Time) {
        if (!(v !== null && v !== undefined && v.constructor === Date)) {
            $throwRuntimeError("cannot internalize time.Time from " + typeof v + ", must be Date");
        }
        return timePkg.Unix(new $Int64(0, 0), new $Int64(0, v.getTime() * 1000000));
    }

    // Cache for values we've already internalized in order to deal with circular
    // references.
    if (seen === undefined) { seen = new Map(); }
    if (!seen.has(t)) { seen.set(t, new Map()); }
    if (seen.get(t).has(v)) { return seen.get(t).get(v); }

    switch (t.kind) {
        case $kindBool:
            return !!v;
        case $kindInt:
            return parseInt(v);
        case $kindInt8:
            return parseInt(v) << 24 >> 24;
        case $kindInt16:
            return parseInt(v) << 16 >> 16;
        case $kindInt32:
            return parseInt(v) >> 0;
        case $kindUint:
            return parseInt(v);
        case $kindUint8:
            return parseInt(v) << 24 >>> 24;
        case $kindUint16:
            return parseInt(v) << 16 >>> 16;
        case $kindUint32:
        case $kindUintptr:
            return parseInt(v) >>> 0;
        case $kindInt64:
        case $kindUint64:
            return new t(0, v);
        case $kindFloat32:
        case $kindFloat64:
            return parseFloat(v);
        case $kindArray:
            if (v.length !== t.len) {
                $throwRuntimeError("got array with wrong size from JavaScript native");
            }
            return $mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); });
        case $kindFunc:
            return function () {
                var args = [];
                for (var i = 0; i < t.params.length; i++) {
                    if (t.variadic && i === t.params.length - 1) {
                        var vt = t.params[i].elem, varargs = arguments[i];
                        for (var j = 0; j < varargs.$length; j++) {
                            args.push($externalize(varargs.$array[varargs.$offset + j], vt, makeWrapper));
                        }
                        break;
                    }
                    args.push($externalize(arguments[i], t.params[i], makeWrapper));
                }
                var result = v.apply(recv, args);
                switch (t.results.length) {
                    case 0:
                        return;
                    case 1:
                        return $internalize(result, t.results[0], makeWrapper);
                    default:
                        for (var i = 0; i < t.results.length; i++) {
                            result[i] = $internalize(result[i], t.results[i], makeWrapper);
                        }
                        return result;
                }
            };
        case $kindInterface:
            if (t.methods.length !== 0) {
                $throwRuntimeError("cannot internalize " + t.string);
            }
            if (v === null) {
                return $ifaceNil;
            }
            if (v === undefined) {
                return new $jsObjectPtr(undefined);
            }
            switch (v.constructor) {
                case Int8Array:
                    return new ($sliceType($Int8))(v);
                case Int16Array:
                    return new ($sliceType($Int16))(v);
                case Int32Array:
                    return new ($sliceType($Int))(v);
                case Uint8Array:
                    return new ($sliceType($Uint8))(v);
                case Uint16Array:
                    return new ($sliceType($Uint16))(v);
                case Uint32Array:
                    return new ($sliceType($Uint))(v);
                case Float32Array:
                    return new ($sliceType($Float32))(v);
                case Float64Array:
                    return new ($sliceType($Float64))(v);
                case Array:
                    return $internalize(v, $sliceType($emptyInterface), makeWrapper);
                case Boolean:
                    return new $Bool(!!v);
                case Date:
                    if (timePkg === undefined) {
                        /* time package is not present, internalize as &js.Object{Date} so it can be externalized into original Date. */
                        return new $jsObjectPtr(v);
                    }
                    return new timePkg.Time($internalize(v, timePkg.Time, makeWrapper));
                case ((() => { })).constructor: // is usually Function, but in Chrome extensions it is something else
                    var funcType = $funcType([$sliceType($emptyInterface)], [$jsObjectPtr], true);
                    return new funcType($internalize(v, funcType, makeWrapper));
                case Number:
                    return new $Float64(parseFloat(v));
                case String:
                    return new $String($internalize(v, $String, makeWrapper));
                default:
                    if ($global.Node && v instanceof $global.Node) {
                        return new $jsObjectPtr(v);
                    }
                    var mapType = $mapType($String, $emptyInterface);
                    return new mapType($internalize(v, mapType, recv, seen, makeWrapper));
            }
        case $kindMap:
            var m = new Map();
            seen.get(t).set(v, m);
            var keys = $keys(v);
            for (var i = 0; i < keys.length; i++) {
                var k = $internalize(keys[i], t.key, recv, seen, makeWrapper);
                m.set(t.key.keyFor(k), { k, v: $internalize(v[keys[i]], t.elem, recv, seen, makeWrapper) });
            }
            return m;
        case $kindPtr:
            if (t.elem.kind === $kindStruct) {
                return $internalize(v, t.elem, makeWrapper);
            }
        case $kindSlice:
            return new t($mapArray(v, e => { return $internalize(e, t.elem, makeWrapper); }));
        case $kindString:
            v = String(v);
            if ($isASCII(v)) {
                return v;
            }
            var s = "";
            var i = 0;
            while (i < v.length) {
                var h = v.charCodeAt(i);
                if (0xD800 <= h && h <= 0xDBFF) {
                    var l = v.charCodeAt(i + 1);
                    var c = (h - 0xD800) * 0x400 + l - 0xDC00 + 0x10000;
                    s += $encodeRune(c);
                    i += 2;
                    continue;
                }
                s += $encodeRune(h);
                i++;
            }
            return s;
        case $kindStruct:
            var noJsObject = {};
            var searchJsObject = t => {
                if (t === $jsObjectPtr) {
                    return v;
                }
                if (t === $jsObjectPtr.elem) {
                    $throwRuntimeError("cannot internalize js.Object, use *js.Object instead");
                }
                switch (t.kind) {
                    case $kindPtr:
                        return searchJsObject(t.elem);
                    case $kindStruct:
                        if (t.fields.length === 0) {
                            return noJsObject;
                        }
                        var f = t.fields[0];
                        var o = searchJsObject(f.typ);
                        if (o !== noJsObject) {
                            var n = new t.ptr();
                            n[f.prop] = o;
                            return n;
                        }
                        return noJsObject;
                    default:
                        return noJsObject;
                }
            };
            var o = searchJsObject(t);
            if (o !== noJsObject) {
                return o;
            }
            var n = new t.ptr();
            for (var i = 0; i < t.fields.length; i++) {
              var f = t.fields[i];
      
              if (!f.exported) {
                continue;
              }
              var jsProp = v[f.name];
      
              n[f.prop] = $internalize(jsProp, f.typ, recv, seen, makeWrapper);
            }
      
            return n;
    }
    $throwRuntimeError("cannot internalize " + t.string);
};

var $copyIfRequired = (v, typ) => {
    // interface values
    if (v && v.constructor && v.constructor.copy) {
        return new v.constructor($clone(v.$val, v.constructor))
    }
    // array and struct values
    if (typ.copy) {
        var clone = typ.zero();
        typ.copy(clone, v);
        return clone;
    }
    return v;
}

/* $isASCII reports whether string s contains only ASCII characters. */
var $isASCII = s => {
    for (var i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) >= 128) {
            return false;
        }
    }
    return true;
};

$packages["github.com/gopherjs/gopherjs/js"] = (function() {
	var $pkg = {}, $init, Object, Error, sliceType, ptrType, ptrType$1, MakeFunc, init;
	Object = $pkg.Object = $newType(0, $kindStruct, "js.Object", true, "github.com/gopherjs/gopherjs/js", true, function(object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.object = null;
			return;
		}
		this.object = object_;
	});
	Error = $pkg.Error = $newType(0, $kindStruct, "js.Error", true, "github.com/gopherjs/gopherjs/js", true, function(Object_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Object = null;
			return;
		}
		this.Object = Object_;
	});
	sliceType = $sliceType($emptyInterface);
	ptrType = $ptrType(Object);
	ptrType$1 = $ptrType(Error);
	Object.ptr.prototype.Get = function(key) {
		var key, o;
		o = this;
		return o.object[$externalize(key, $String)];
	};
	Object.prototype.Get = function(key) { return this.$val.Get(key); };
	Object.ptr.prototype.Set = function(key, value) {
		var key, o, value;
		o = this;
		o.object[$externalize(key, $String)] = $externalize(value, $emptyInterface);
	};
	Object.prototype.Set = function(key, value) { return this.$val.Set(key, value); };
	Object.ptr.prototype.Delete = function(key) {
		var key, o;
		o = this;
		delete o.object[$externalize(key, $String)];
	};
	Object.prototype.Delete = function(key) { return this.$val.Delete(key); };
	Object.ptr.prototype.Length = function() {
		var o;
		o = this;
		return $parseInt(o.object.length);
	};
	Object.prototype.Length = function() { return this.$val.Length(); };
	Object.ptr.prototype.Index = function(i) {
		var i, o;
		o = this;
		return o.object[i];
	};
	Object.prototype.Index = function(i) { return this.$val.Index(i); };
	Object.ptr.prototype.SetIndex = function(i, value) {
		var i, o, value;
		o = this;
		o.object[i] = $externalize(value, $emptyInterface);
	};
	Object.prototype.SetIndex = function(i, value) { return this.$val.SetIndex(i, value); };
	Object.ptr.prototype.Call = function(name, args) {
		var args, name, o, obj;
		o = this;
		return (obj = o.object, obj[$externalize(name, $String)].apply(obj, $externalize(args, sliceType)));
	};
	Object.prototype.Call = function(name, args) { return this.$val.Call(name, args); };
	Object.ptr.prototype.Invoke = function(args) {
		var args, o;
		o = this;
		return o.object.apply(undefined, $externalize(args, sliceType));
	};
	Object.prototype.Invoke = function(args) { return this.$val.Invoke(args); };
	Object.ptr.prototype.New = function(args) {
		var args, o;
		o = this;
		return new ($global.Function.prototype.bind.apply(o.object, [undefined].concat($externalize(args, sliceType))));
	};
	Object.prototype.New = function(args) { return this.$val.New(args); };
	Object.ptr.prototype.Bool = function() {
		var o;
		o = this;
		return !!(o.object);
	};
	Object.prototype.Bool = function() { return this.$val.Bool(); };
	Object.ptr.prototype.String = function() {
		var o;
		o = this;
		return $internalize(o.object, $String);
	};
	Object.prototype.String = function() { return this.$val.String(); };
	Object.ptr.prototype.Int = function() {
		var o;
		o = this;
		return $parseInt(o.object) >> 0;
	};
	Object.prototype.Int = function() { return this.$val.Int(); };
	Object.ptr.prototype.Int64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Int64);
	};
	Object.prototype.Int64 = function() { return this.$val.Int64(); };
	Object.ptr.prototype.Uint64 = function() {
		var o;
		o = this;
		return $internalize(o.object, $Uint64);
	};
	Object.prototype.Uint64 = function() { return this.$val.Uint64(); };
	Object.ptr.prototype.Float = function() {
		var o;
		o = this;
		return $parseFloat(o.object);
	};
	Object.prototype.Float = function() { return this.$val.Float(); };
	Object.ptr.prototype.Interface = function() {
		var o;
		o = this;
		return $internalize(o.object, $emptyInterface);
	};
	Object.prototype.Interface = function() { return this.$val.Interface(); };
	Object.ptr.prototype.Unsafe = function() {
		var o;
		o = this;
		return o.object;
	};
	Object.prototype.Unsafe = function() { return this.$val.Unsafe(); };
	Error.ptr.prototype.Error = function() {
		var err;
		err = this;
		return "JavaScript error: " + $internalize(err.Object.message, $String);
	};
	Error.prototype.Error = function() { return this.$val.Error(); };
	Error.ptr.prototype.Stack = function() {
		var err;
		err = this;
		return $internalize(err.Object.stack, $String);
	};
	Error.prototype.Stack = function() { return this.$val.Stack(); };
	MakeFunc = function(fn) {
		var fn;
		return $makeFunc(fn);
	};
	$pkg.MakeFunc = MakeFunc;
	init = function() {
		var e;
		e = new Error.ptr(null);
		$unused(e);
	};
	ptrType.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([$String], [ptrType], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([$String, $emptyInterface], [], false)}, {prop: "Delete", name: "Delete", pkg: "", typ: $funcType([$String], [], false)}, {prop: "Length", name: "Length", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [ptrType], false)}, {prop: "SetIndex", name: "SetIndex", pkg: "", typ: $funcType([$Int, $emptyInterface], [], false)}, {prop: "Call", name: "Call", pkg: "", typ: $funcType([$String, sliceType], [ptrType], true)}, {prop: "Invoke", name: "Invoke", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "New", name: "New", pkg: "", typ: $funcType([sliceType], [ptrType], true)}, {prop: "Bool", name: "Bool", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Int", name: "Int", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Int64", name: "Int64", pkg: "", typ: $funcType([], [$Int64], false)}, {prop: "Uint64", name: "Uint64", pkg: "", typ: $funcType([], [$Uint64], false)}, {prop: "Float", name: "Float", pkg: "", typ: $funcType([], [$Float64], false)}, {prop: "Interface", name: "Interface", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Unsafe", name: "Unsafe", pkg: "", typ: $funcType([], [$Uintptr], false)}];
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Stack", name: "Stack", pkg: "", typ: $funcType([], [$String], false)}];
	Object.init("github.com/gopherjs/gopherjs/js", [{prop: "object", name: "object", embedded: false, exported: false, typ: ptrType, tag: ""}]);
	Error.init("", [{prop: "Object", name: "Object", embedded: true, exported: true, typ: ptrType, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["runtime"] = (function() {
	var $pkg = {}, $init, js, _type, TypeAssertionError, errorString, ptrType$1, ptrType$2, buildVersion, init, throw$1, nanotime;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	_type = $pkg._type = $newType(0, $kindStruct, "runtime._type", true, "runtime", false, function(str_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.str = "";
			return;
		}
		this.str = str_;
	});
	TypeAssertionError = $pkg.TypeAssertionError = $newType(0, $kindStruct, "runtime.TypeAssertionError", true, "runtime", true, function(_interface_, concrete_, asserted_, missingMethod_) {
		this.$val = this;
		if (arguments.length === 0) {
			this._interface = ptrType$1.nil;
			this.concrete = ptrType$1.nil;
			this.asserted = ptrType$1.nil;
			this.missingMethod = "";
			return;
		}
		this._interface = _interface_;
		this.concrete = concrete_;
		this.asserted = asserted_;
		this.missingMethod = missingMethod_;
	});
	errorString = $pkg.errorString = $newType(8, $kindString, "runtime.errorString", true, "runtime", false, null);
	ptrType$1 = $ptrType(_type);
	ptrType$2 = $ptrType(TypeAssertionError);
	_type.ptr.prototype.string = function() {
		var t;
		t = this;
		return t.str;
	};
	_type.prototype.string = function() { return this.$val.string(); };
	_type.ptr.prototype.pkgpath = function() {
		var t;
		t = this;
		return "";
	};
	_type.prototype.pkgpath = function() { return this.$val.pkgpath(); };
	TypeAssertionError.ptr.prototype.RuntimeError = function() {
	};
	TypeAssertionError.prototype.RuntimeError = function() { return this.$val.RuntimeError(); };
	TypeAssertionError.ptr.prototype.Error = function() {
		var as, cs, e, inter, msg;
		e = this;
		inter = "interface";
		if (!(e._interface === ptrType$1.nil)) {
			inter = e._interface.string();
		}
		as = e.asserted.string();
		if (e.concrete === ptrType$1.nil) {
			return "interface conversion: " + inter + " is nil, not " + as;
		}
		cs = e.concrete.string();
		if (e.missingMethod === "") {
			msg = "interface conversion: " + inter + " is " + cs + ", not " + as;
			if (cs === as) {
				if (!(e.concrete.pkgpath() === e.asserted.pkgpath())) {
					msg = msg + (" (types from different packages)");
				} else {
					msg = msg + (" (types from different scopes)");
				}
			}
			return msg;
		}
		return "interface conversion: " + cs + " is not " + as + ": missing method " + e.missingMethod;
	};
	TypeAssertionError.prototype.Error = function() { return this.$val.Error(); };
	init = function() {
		var e, jsPkg;
		jsPkg = $packages[$externalize("github.com/gopherjs/gopherjs/js", $String)];
		$jsObjectPtr = jsPkg.Object.ptr;
		$jsErrorPtr = jsPkg.Error.ptr;
		$throwRuntimeError = throw$1;
		buildVersion = $internalize($goVersion, $String);
		e = $ifaceNil;
		e = new TypeAssertionError.ptr(ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, "");
		$unused(e);
	};
	errorString.prototype.RuntimeError = function() {
		var e;
		e = this.$val;
	};
	$ptrType(errorString).prototype.RuntimeError = function() { return new errorString(this.$get()).RuntimeError(); };
	errorString.prototype.Error = function() {
		var e;
		e = this.$val;
		return "runtime error: " + (e);
	};
	$ptrType(errorString).prototype.Error = function() { return new errorString(this.$get()).Error(); };
	throw$1 = function(s) {
		var s;
		$panic(new errorString((s)));
	};
	nanotime = function() {
		return $mul64($internalize(new ($global.Date)().getTime(), $Int64), new $Int64(0, 1000000));
	};
	$linknames["runtime.nanotime"] = nanotime;
	ptrType$1.methods = [{prop: "string", name: "string", pkg: "runtime", typ: $funcType([], [$String], false)}, {prop: "pkgpath", name: "pkgpath", pkg: "runtime", typ: $funcType([], [$String], false)}];
	ptrType$2.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.methods = [{prop: "RuntimeError", name: "RuntimeError", pkg: "", typ: $funcType([], [], false)}, {prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	_type.init("runtime", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	TypeAssertionError.init("runtime", [{prop: "_interface", name: "_interface", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "concrete", name: "concrete", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "asserted", name: "asserted", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "missingMethod", name: "missingMethod", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		buildVersion = "";
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/goarch"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/reflectlite"] = (function() {
	var $pkg = {}, $init, js, goarch, Value, flag, ValueError, Type, Kind, tflag, rtype, method, chanDir, arrayType, chanType, imethod, interfaceType, mapType, ptrType, sliceType, structField, structType, nameOff, typeOff, textOff, errorString, Method, uncommonType, funcType, name, nameData, mapIter, TypeEx, ptrType$1, sliceType$1, sliceType$2, sliceType$3, sliceType$4, ptrType$2, funcType$1, ptrType$4, sliceType$5, ptrType$5, sliceType$6, ptrType$6, ptrType$7, sliceType$7, sliceType$8, sliceType$9, sliceType$10, ptrType$8, structType$2, ptrType$9, arrayType$2, sliceType$13, ptrType$10, funcType$2, ptrType$11, funcType$3, ptrType$12, ptrType$13, kindNames, callHelper, initialized, uint8Type, idJsType, idReflectType, idKindType, idRtype, uncommonTypeMap, nameMap, nameOffList, typeOffList, jsObjectPtr, selectHelper, implements$1, directlyAssignable, haveIdenticalType, haveIdenticalUnderlyingType, toType, ifaceIndir, unquote, Swapper, init, jsType, reflectType, setKindType, newName, newNameOff, newTypeOff, internalStr, isWrapped, copyStruct, makeValue, TypeOf, ValueOf, FuncOf, SliceOf, unsafe_New, typedmemmove, keyFor, mapaccess, mapiterinit, mapiterkey, mapiternext, maplen, methodReceiver, valueInterface, ifaceE2I, methodName, makeMethodValue, wrapJsObject, unwrapJsObject, getJsTag, PtrTo, copyVal;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	goarch = $packages["internal/goarch"];
	Value = $pkg.Value = $newType(0, $kindStruct, "reflectlite.Value", true, "internal/reflectlite", true, function(typ_, ptr_, flag_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.typ = ptrType$1.nil;
			this.ptr = 0;
			this.flag = 0;
			return;
		}
		this.typ = typ_;
		this.ptr = ptr_;
		this.flag = flag_;
	});
	flag = $pkg.flag = $newType(4, $kindUintptr, "reflectlite.flag", true, "internal/reflectlite", false, null);
	ValueError = $pkg.ValueError = $newType(0, $kindStruct, "reflectlite.ValueError", true, "internal/reflectlite", true, function(Method_, Kind_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Method = "";
			this.Kind = 0;
			return;
		}
		this.Method = Method_;
		this.Kind = Kind_;
	});
	Type = $pkg.Type = $newType(8, $kindInterface, "reflectlite.Type", true, "internal/reflectlite", true, null);
	Kind = $pkg.Kind = $newType(4, $kindUint, "reflectlite.Kind", true, "internal/reflectlite", true, null);
	tflag = $pkg.tflag = $newType(1, $kindUint8, "reflectlite.tflag", true, "internal/reflectlite", false, null);
	rtype = $pkg.rtype = $newType(0, $kindStruct, "reflectlite.rtype", true, "internal/reflectlite", false, function(size_, ptrdata_, hash_, tflag_, align_, fieldAlign_, kind_, equal_, gcdata_, str_, ptrToThis_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.size = 0;
			this.ptrdata = 0;
			this.hash = 0;
			this.tflag = 0;
			this.align = 0;
			this.fieldAlign = 0;
			this.kind = 0;
			this.equal = $throwNilPointerError;
			this.gcdata = ptrType$6.nil;
			this.str = 0;
			this.ptrToThis = 0;
			return;
		}
		this.size = size_;
		this.ptrdata = ptrdata_;
		this.hash = hash_;
		this.tflag = tflag_;
		this.align = align_;
		this.fieldAlign = fieldAlign_;
		this.kind = kind_;
		this.equal = equal_;
		this.gcdata = gcdata_;
		this.str = str_;
		this.ptrToThis = ptrToThis_;
	});
	method = $pkg.method = $newType(0, $kindStruct, "reflectlite.method", true, "internal/reflectlite", false, function(name_, mtyp_, ifn_, tfn_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.mtyp = 0;
			this.ifn = 0;
			this.tfn = 0;
			return;
		}
		this.name = name_;
		this.mtyp = mtyp_;
		this.ifn = ifn_;
		this.tfn = tfn_;
	});
	chanDir = $pkg.chanDir = $newType(4, $kindInt, "reflectlite.chanDir", true, "internal/reflectlite", false, null);
	arrayType = $pkg.arrayType = $newType(0, $kindStruct, "reflectlite.arrayType", true, "internal/reflectlite", false, function(rtype_, elem_, slice_, len_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.slice = ptrType$1.nil;
			this.len = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.slice = slice_;
		this.len = len_;
	});
	chanType = $pkg.chanType = $newType(0, $kindStruct, "reflectlite.chanType", true, "internal/reflectlite", false, function(rtype_, elem_, dir_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			this.dir = 0;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
		this.dir = dir_;
	});
	imethod = $pkg.imethod = $newType(0, $kindStruct, "reflectlite.imethod", true, "internal/reflectlite", false, function(name_, typ_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = 0;
			this.typ = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
	});
	interfaceType = $pkg.interfaceType = $newType(0, $kindStruct, "reflectlite.interfaceType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.methods = sliceType$9.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.methods = methods_;
	});
	mapType = $pkg.mapType = $newType(0, $kindStruct, "reflectlite.mapType", true, "internal/reflectlite", false, function(rtype_, key_, elem_, bucket_, hasher_, keysize_, valuesize_, bucketsize_, flags_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.key = ptrType$1.nil;
			this.elem = ptrType$1.nil;
			this.bucket = ptrType$1.nil;
			this.hasher = $throwNilPointerError;
			this.keysize = 0;
			this.valuesize = 0;
			this.bucketsize = 0;
			this.flags = 0;
			return;
		}
		this.rtype = rtype_;
		this.key = key_;
		this.elem = elem_;
		this.bucket = bucket_;
		this.hasher = hasher_;
		this.keysize = keysize_;
		this.valuesize = valuesize_;
		this.bucketsize = bucketsize_;
		this.flags = flags_;
	});
	ptrType = $pkg.ptrType = $newType(0, $kindStruct, "reflectlite.ptrType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	sliceType = $pkg.sliceType = $newType(0, $kindStruct, "reflectlite.sliceType", true, "internal/reflectlite", false, function(rtype_, elem_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.elem = ptrType$1.nil;
			return;
		}
		this.rtype = rtype_;
		this.elem = elem_;
	});
	structField = $pkg.structField = $newType(0, $kindStruct, "reflectlite.structField", true, "internal/reflectlite", false, function(name_, typ_, offset_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = new name.ptr(ptrType$6.nil);
			this.typ = ptrType$1.nil;
			this.offset = 0;
			return;
		}
		this.name = name_;
		this.typ = typ_;
		this.offset = offset_;
	});
	structType = $pkg.structType = $newType(0, $kindStruct, "reflectlite.structType", true, "internal/reflectlite", false, function(rtype_, pkgPath_, fields_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.pkgPath = new name.ptr(ptrType$6.nil);
			this.fields = sliceType$10.nil;
			return;
		}
		this.rtype = rtype_;
		this.pkgPath = pkgPath_;
		this.fields = fields_;
	});
	nameOff = $pkg.nameOff = $newType(4, $kindInt32, "reflectlite.nameOff", true, "internal/reflectlite", false, null);
	typeOff = $pkg.typeOff = $newType(4, $kindInt32, "reflectlite.typeOff", true, "internal/reflectlite", false, null);
	textOff = $pkg.textOff = $newType(4, $kindInt32, "reflectlite.textOff", true, "internal/reflectlite", false, null);
	errorString = $pkg.errorString = $newType(0, $kindStruct, "reflectlite.errorString", true, "internal/reflectlite", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	Method = $pkg.Method = $newType(0, $kindStruct, "reflectlite.Method", true, "internal/reflectlite", true, function(Name_, PkgPath_, Type_, Func_, Index_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Name = "";
			this.PkgPath = "";
			this.Type = $ifaceNil;
			this.Func = new Value.ptr(ptrType$1.nil, 0, 0);
			this.Index = 0;
			return;
		}
		this.Name = Name_;
		this.PkgPath = PkgPath_;
		this.Type = Type_;
		this.Func = Func_;
		this.Index = Index_;
	});
	uncommonType = $pkg.uncommonType = $newType(0, $kindStruct, "reflectlite.uncommonType", true, "internal/reflectlite", false, function(pkgPath_, mcount_, xcount_, moff_, _methods_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.pkgPath = 0;
			this.mcount = 0;
			this.xcount = 0;
			this.moff = 0;
			this._methods = sliceType$5.nil;
			return;
		}
		this.pkgPath = pkgPath_;
		this.mcount = mcount_;
		this.xcount = xcount_;
		this.moff = moff_;
		this._methods = _methods_;
	});
	funcType = $pkg.funcType = $newType(0, $kindStruct, "reflectlite.funcType", true, "internal/reflectlite", false, function(rtype_, inCount_, outCount_, _in_, _out_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.rtype = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
			this.inCount = 0;
			this.outCount = 0;
			this._in = sliceType$2.nil;
			this._out = sliceType$2.nil;
			return;
		}
		this.rtype = rtype_;
		this.inCount = inCount_;
		this.outCount = outCount_;
		this._in = _in_;
		this._out = _out_;
	});
	name = $pkg.name = $newType(0, $kindStruct, "reflectlite.name", true, "internal/reflectlite", false, function(bytes_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.bytes = ptrType$6.nil;
			return;
		}
		this.bytes = bytes_;
	});
	nameData = $pkg.nameData = $newType(0, $kindStruct, "reflectlite.nameData", true, "internal/reflectlite", false, function(name_, tag_, exported_, embedded_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.name = "";
			this.tag = "";
			this.exported = false;
			this.embedded = false;
			return;
		}
		this.name = name_;
		this.tag = tag_;
		this.exported = exported_;
		this.embedded = embedded_;
	});
	mapIter = $pkg.mapIter = $newType(0, $kindStruct, "reflectlite.mapIter", true, "internal/reflectlite", false, function(t_, m_, keys_, i_, last_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.t = $ifaceNil;
			this.m = null;
			this.keys = null;
			this.i = 0;
			this.last = null;
			return;
		}
		this.t = t_;
		this.m = m_;
		this.keys = keys_;
		this.i = i_;
		this.last = last_;
	});
	TypeEx = $pkg.TypeEx = $newType(8, $kindInterface, "reflectlite.TypeEx", true, "internal/reflectlite", true, null);
	ptrType$1 = $ptrType(rtype);
	sliceType$1 = $sliceType(name);
	sliceType$2 = $sliceType(ptrType$1);
	sliceType$3 = $sliceType($String);
	sliceType$4 = $sliceType($emptyInterface);
	ptrType$2 = $ptrType(js.Object);
	funcType$1 = $funcType([sliceType$4], [ptrType$2], true);
	ptrType$4 = $ptrType(uncommonType);
	sliceType$5 = $sliceType(method);
	ptrType$5 = $ptrType(funcType);
	sliceType$6 = $sliceType(Value);
	ptrType$6 = $ptrType($Uint8);
	ptrType$7 = $ptrType($UnsafePointer);
	sliceType$7 = $sliceType(Type);
	sliceType$8 = $sliceType(ptrType$2);
	sliceType$9 = $sliceType(imethod);
	sliceType$10 = $sliceType(structField);
	ptrType$8 = $ptrType(nameData);
	structType$2 = $structType("internal/reflectlite", [{prop: "str", name: "str", embedded: false, exported: false, typ: $String, tag: ""}]);
	ptrType$9 = $ptrType(mapIter);
	arrayType$2 = $arrayType($Uintptr, 2);
	sliceType$13 = $sliceType($Uint8);
	ptrType$10 = $ptrType(ValueError);
	funcType$2 = $funcType([$UnsafePointer, $UnsafePointer], [$Bool], false);
	ptrType$11 = $ptrType(interfaceType);
	funcType$3 = $funcType([$UnsafePointer, $Uintptr], [$Uintptr], false);
	ptrType$12 = $ptrType(structField);
	ptrType$13 = $ptrType(errorString);
	flag.prototype.kind = function() {
		var f;
		f = this.$val;
		return ((((f & 31) >>> 0) >>> 0));
	};
	$ptrType(flag).prototype.kind = function() { return new flag(this.$get()).kind(); };
	flag.prototype.ro = function() {
		var f;
		f = this.$val;
		if (!((((f & 96) >>> 0) === 0))) {
			return 32;
		}
		return 0;
	};
	$ptrType(flag).prototype.ro = function() { return new flag(this.$get()).ro(); };
	Value.ptr.prototype.pointer = function() {
		var v;
		v = this;
		if (!((v.typ.size === 4)) || !v.typ.pointers()) {
			$panic(new $String("can't call pointer on a non-pointer Value"));
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			return (v.ptr).$get();
		}
		return v.ptr;
	};
	Value.prototype.pointer = function() { return this.$val.pointer(); };
	ValueError.ptr.prototype.Error = function() {
		var e;
		e = this;
		if (e.Kind === 0) {
			return "reflect: call of " + e.Method + " on zero Value";
		}
		return "reflect: call of " + e.Method + " on " + new Kind(e.Kind).String() + " Value";
	};
	ValueError.prototype.Error = function() { return this.$val.Error(); };
	flag.prototype.mustBeExported = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
	};
	$ptrType(flag).prototype.mustBeExported = function() { return new flag(this.$get()).mustBeExported(); };
	flag.prototype.mustBeAssignable = function() {
		var f;
		f = this.$val;
		if (f === 0) {
			$panic(new ValueError.ptr(methodName(), 0));
		}
		if (!((((f & 96) >>> 0) === 0))) {
			$panic(new $String("reflect: " + methodName() + " using value obtained using unexported field"));
		}
		if (((f & 256) >>> 0) === 0) {
			$panic(new $String("reflect: " + methodName() + " using unaddressable value"));
		}
	};
	$ptrType(flag).prototype.mustBeAssignable = function() { return new flag(this.$get()).mustBeAssignable(); };
	Value.ptr.prototype.CanSet = function() {
		var v;
		v = this;
		return ((v.flag & 352) >>> 0) === 256;
	};
	Value.prototype.CanSet = function() { return this.$val.CanSet(); };
	Value.ptr.prototype.IsValid = function() {
		var v;
		v = this;
		return !((v.flag === 0));
	};
	Value.prototype.IsValid = function() { return this.$val.IsValid(); };
	Value.ptr.prototype.Kind = function() {
		var v;
		v = this;
		return new flag(v.flag).kind();
	};
	Value.prototype.Kind = function() { return this.$val.Kind(); };
	Value.ptr.prototype.Type = function() {
		var f, v;
		v = this;
		f = v.flag;
		if (f === 0) {
			$panic(new ValueError.ptr("reflectlite.Value.Type", 0));
		}
		return v.typ;
	};
	Value.prototype.Type = function() { return this.$val.Type(); };
	structField.ptr.prototype.embedded = function() {
		var f;
		f = this;
		return $clone(f.name, name).embedded();
	};
	structField.prototype.embedded = function() { return this.$val.embedded(); };
	Kind.prototype.String = function() {
		var k;
		k = this.$val;
		if (((k >> 0)) < kindNames.$length) {
			return ((k < 0 || k >= kindNames.$length) ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + k]);
		}
		return (0 >= kindNames.$length ? ($throwRuntimeError("index out of range"), undefined) : kindNames.$array[kindNames.$offset + 0]);
	};
	$ptrType(Kind).prototype.String = function() { return new Kind(this.$get()).String(); };
	rtype.ptr.prototype.String = function() {
		var s, t;
		t = this;
		s = $clone(t.nameOff(t.str), name).name();
		if (!((((t.tflag & 2) >>> 0) === 0))) {
			return $substring(s, 1);
		}
		return s;
	};
	rtype.prototype.String = function() { return this.$val.String(); };
	rtype.ptr.prototype.Size = function() {
		var t;
		t = this;
		return t.size;
	};
	rtype.prototype.Size = function() { return this.$val.Size(); };
	rtype.ptr.prototype.Kind = function() {
		var t;
		t = this;
		return ((((t.kind & 31) >>> 0) >>> 0));
	};
	rtype.prototype.Kind = function() { return this.$val.Kind(); };
	rtype.ptr.prototype.pointers = function() {
		var t;
		t = this;
		return !((t.ptrdata === 0));
	};
	rtype.prototype.pointers = function() { return this.$val.pointers(); };
	rtype.ptr.prototype.common = function() {
		var t;
		t = this;
		return t;
	};
	rtype.prototype.common = function() { return this.$val.common(); };
	rtype.ptr.prototype.exportedMethods = function() {
		var t, ut;
		t = this;
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return sliceType$5.nil;
		}
		return ut.exportedMethods();
	};
	rtype.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.NumMethod = function() {
		var t, tt;
		t = this;
		if (t.Kind() === 20) {
			tt = (t.kindType);
			return tt.NumMethod();
		}
		return t.exportedMethods().$length;
	};
	rtype.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.PkgPath = function() {
		var t, ut;
		t = this;
		if (((t.tflag & 4) >>> 0) === 0) {
			return "";
		}
		ut = t.uncommon();
		if (ut === ptrType$4.nil) {
			return "";
		}
		return $clone(t.nameOff(ut.pkgPath), name).name();
	};
	rtype.prototype.PkgPath = function() { return this.$val.PkgPath(); };
	rtype.ptr.prototype.hasName = function() {
		var t;
		t = this;
		return !((((t.tflag & 4) >>> 0) === 0));
	};
	rtype.prototype.hasName = function() { return this.$val.hasName(); };
	rtype.ptr.prototype.Name = function() {
		var _1, i, s, sqBrackets, t;
		t = this;
		if (!t.hasName()) {
			return "";
		}
		s = t.String();
		i = s.length - 1 >> 0;
		sqBrackets = 0;
		while (true) {
			if (!(i >= 0 && (!((s.charCodeAt(i) === 46)) || !((sqBrackets === 0))))) { break; }
			_1 = s.charCodeAt(i);
			if (_1 === (93)) {
				sqBrackets = sqBrackets + (1) >> 0;
			} else if (_1 === (91)) {
				sqBrackets = sqBrackets - (1) >> 0;
			}
			i = i - (1) >> 0;
		}
		return $substring(s, (i + 1 >> 0));
	};
	rtype.prototype.Name = function() { return this.$val.Name(); };
	rtype.ptr.prototype.chanDir = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 18))) {
			$panic(new $String("reflect: chanDir of non-chan type"));
		}
		tt = (t.kindType);
		return ((tt.dir >> 0));
	};
	rtype.prototype.chanDir = function() { return this.$val.chanDir(); };
	rtype.ptr.prototype.Elem = function() {
		var _1, t, tt, tt$1, tt$2, tt$3, tt$4;
		t = this;
		_1 = t.Kind();
		if (_1 === (17)) {
			tt = (t.kindType);
			return toType(tt.elem);
		} else if (_1 === (18)) {
			tt$1 = (t.kindType);
			return toType(tt$1.elem);
		} else if (_1 === (21)) {
			tt$2 = (t.kindType);
			return toType(tt$2.elem);
		} else if (_1 === (22)) {
			tt$3 = (t.kindType);
			return toType(tt$3.elem);
		} else if (_1 === (23)) {
			tt$4 = (t.kindType);
			return toType(tt$4.elem);
		}
		$panic(new $String("reflect: Elem of invalid type"));
	};
	rtype.prototype.Elem = function() { return this.$val.Elem(); };
	rtype.ptr.prototype.In = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: In of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.in$(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.In = function(i) { return this.$val.In(i); };
	rtype.ptr.prototype.Len = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 17))) {
			$panic(new $String("reflect: Len of non-array type"));
		}
		tt = (t.kindType);
		return ((tt.len >> 0));
	};
	rtype.prototype.Len = function() { return this.$val.Len(); };
	rtype.ptr.prototype.NumIn = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumIn of non-func type"));
		}
		tt = (t.kindType);
		return ((tt.inCount >> 0));
	};
	rtype.prototype.NumIn = function() { return this.$val.NumIn(); };
	rtype.ptr.prototype.NumOut = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: NumOut of non-func type"));
		}
		tt = (t.kindType);
		return tt.out().$length;
	};
	rtype.prototype.NumOut = function() { return this.$val.NumOut(); };
	rtype.ptr.prototype.Out = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: Out of non-func type"));
		}
		tt = (t.kindType);
		return toType((x = tt.out(), ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i])));
	};
	rtype.prototype.Out = function(i) { return this.$val.Out(i); };
	interfaceType.ptr.prototype.NumMethod = function() {
		var t;
		t = this;
		return t.methods.$length;
	};
	interfaceType.prototype.NumMethod = function() { return this.$val.NumMethod(); };
	rtype.ptr.prototype.Implements = function(u) {
		var {_r, t, u, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.Implements"));
		}
		_r = u.Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 20))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 20))) { */ case 1:
			$panic(new $String("reflect: non-interface type passed to Type.Implements"));
		/* } */ case 2:
		$s = -1; return implements$1($assertType(u, ptrType$1), t);
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Implements, $c: true, $r, _r, t, u, $s};return $f;
	};
	rtype.prototype.Implements = function(u) { return this.$val.Implements(u); };
	rtype.ptr.prototype.AssignableTo = function(u) {
		var {$24r, _r, t, u, uu, $s, $r, $c} = $restore(this, {u});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
		if ($interfaceIsEqual(u, $ifaceNil)) {
			$panic(new $String("reflect: nil type passed to Type.AssignableTo"));
		}
		uu = $assertType(u, ptrType$1);
		_r = directlyAssignable(uu, t); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r || implements$1(uu, t);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.AssignableTo, $c: true, $r, $24r, _r, t, u, uu, $s};return $f;
	};
	rtype.prototype.AssignableTo = function(u) { return this.$val.AssignableTo(u); };
	implements$1 = function(T, V) {
		var T, V, i, i$1, j, j$1, t, tm, tm$1, tmName, tmName$1, tmPkgPath, tmPkgPath$1, v, v$1, vm, vm$1, vmName, vmName$1, vmPkgPath, vmPkgPath$1, vmethods, x, x$1, x$2;
		if (!((T.Kind() === 20))) {
			return false;
		}
		t = (T.kindType);
		if (t.methods.$length === 0) {
			return true;
		}
		if (V.Kind() === 20) {
			v = (V.kindType);
			i = 0;
			j = 0;
			while (true) {
				if (!(j < v.methods.$length)) { break; }
				tm = (x = t.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
				tmName = $clone(t.rtype.nameOff(tm.name), name);
				vm = (x$1 = v.methods, ((j < 0 || j >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + j]));
				vmName = $clone(V.nameOff(vm.name), name);
				if ($clone(vmName, name).name() === $clone(tmName, name).name() && V.typeOff(vm.typ) === t.rtype.typeOff(tm.typ)) {
					if (!$clone(tmName, name).isExported()) {
						tmPkgPath = $clone(tmName, name).pkgPath();
						if (tmPkgPath === "") {
							tmPkgPath = $clone(t.pkgPath, name).name();
						}
						vmPkgPath = $clone(vmName, name).pkgPath();
						if (vmPkgPath === "") {
							vmPkgPath = $clone(v.pkgPath, name).name();
						}
						if (!(tmPkgPath === vmPkgPath)) {
							j = j + (1) >> 0;
							continue;
						}
					}
					i = i + (1) >> 0;
					if (i >= t.methods.$length) {
						return true;
					}
				}
				j = j + (1) >> 0;
			}
			return false;
		}
		v$1 = V.uncommon();
		if (v$1 === ptrType$4.nil) {
			return false;
		}
		i$1 = 0;
		vmethods = v$1.methods();
		j$1 = 0;
		while (true) {
			if (!(j$1 < ((v$1.mcount >> 0)))) { break; }
			tm$1 = (x$2 = t.methods, ((i$1 < 0 || i$1 >= x$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$2.$array[x$2.$offset + i$1]));
			tmName$1 = $clone(t.rtype.nameOff(tm$1.name), name);
			vm$1 = $clone(((j$1 < 0 || j$1 >= vmethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : vmethods.$array[vmethods.$offset + j$1]), method);
			vmName$1 = $clone(V.nameOff(vm$1.name), name);
			if ($clone(vmName$1, name).name() === $clone(tmName$1, name).name() && V.typeOff(vm$1.mtyp) === t.rtype.typeOff(tm$1.typ)) {
				if (!$clone(tmName$1, name).isExported()) {
					tmPkgPath$1 = $clone(tmName$1, name).pkgPath();
					if (tmPkgPath$1 === "") {
						tmPkgPath$1 = $clone(t.pkgPath, name).name();
					}
					vmPkgPath$1 = $clone(vmName$1, name).pkgPath();
					if (vmPkgPath$1 === "") {
						vmPkgPath$1 = $clone(V.nameOff(v$1.pkgPath), name).name();
					}
					if (!(tmPkgPath$1 === vmPkgPath$1)) {
						j$1 = j$1 + (1) >> 0;
						continue;
					}
				}
				i$1 = i$1 + (1) >> 0;
				if (i$1 >= t.methods.$length) {
					return true;
				}
			}
			j$1 = j$1 + (1) >> 0;
		}
		return false;
	};
	directlyAssignable = function(T, V) {
		var {$24r, T, V, _r, $s, $r, $c} = $restore(this, {T, V});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		if (T.hasName() && V.hasName() || !((T.Kind() === V.Kind()))) {
			$s = -1; return false;
		}
		_r = haveIdenticalUnderlyingType(T, V, true); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: directlyAssignable, $c: true, $r, $24r, T, V, _r, $s};return $f;
	};
	haveIdenticalType = function(T, V, cmpTags) {
		var {$24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (cmpTags) {
			$s = -1; return $interfaceIsEqual(T, V);
		}
		_r = T.Name(); /* */ $s = 4; case 4: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = V.Name(); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (!(_r === _r$1)) { _v = true; $s = 3; continue s; }
		_r$2 = T.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_r$3 = V.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = !((_r$2 === _r$3)); case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$s = -1; return false;
		/* } */ case 2:
		_r$4 = T.common(); /* */ $s = 8; case 8: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
		_arg = _r$4;
		_r$5 = V.common(); /* */ $s = 9; case 9: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		_arg$1 = _r$5;
		_r$6 = haveIdenticalUnderlyingType(_arg, _arg$1, false); /* */ $s = 10; case 10: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
		$24r = _r$6;
		$s = 11; case 11: return $24r;
		/* */ } return; } var $f = {$blk: haveIdenticalType, $c: true, $r, $24r, T, V, _arg, _arg$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _v, cmpTags, $s};return $f;
	};
	haveIdenticalUnderlyingType = function(T, V, cmpTags) {
		var {$24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s, $r, $c} = $restore(this, {T, V, cmpTags});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (T === V) {
			$s = -1; return true;
		}
		kind = T.Kind();
		if (!((kind === V.Kind()))) {
			$s = -1; return false;
		}
		if (1 <= kind && kind <= 16 || (kind === 24) || (kind === 26)) {
			$s = -1; return true;
		}
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (18)) { $s = 3; continue; }
			/* */ if (_1 === (19)) { $s = 4; continue; }
			/* */ if (_1 === (20)) { $s = 5; continue; }
			/* */ if (_1 === (21)) { $s = 6; continue; }
			/* */ if ((_1 === (22)) || (_1 === (23))) { $s = 7; continue; }
			/* */ if (_1 === (25)) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if (_1 === (17)) { */ case 2:
				if (!(T.Len() === V.Len())) { _v = false; $s = 10; continue s; }
				_r = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 11; case 11: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 10:
				$24r = _v;
				$s = 12; case 12: return $24r;
			/* } else if (_1 === (18)) { */ case 3:
				if (!(V.chanDir() === 3)) { _v$1 = false; $s = 15; continue s; }
				_r$1 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 16; case 16: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 15:
				/* */ if (_v$1) { $s = 13; continue; }
				/* */ $s = 14; continue;
				/* if (_v$1) { */ case 13:
					$s = -1; return true;
				/* } */ case 14:
				if (!(V.chanDir() === T.chanDir())) { _v$2 = false; $s = 17; continue s; }
				_r$2 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 18; case 18: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 17:
				$24r$1 = _v$2;
				$s = 19; case 19: return $24r$1;
			/* } else if (_1 === (19)) { */ case 4:
				t = (T.kindType);
				v = (V.kindType);
				if (!((t.outCount === v.outCount)) || !((t.inCount === v.inCount))) {
					$s = -1; return false;
				}
				i = 0;
				/* while (true) { */ case 20:
					/* if (!(i < t.rtype.NumIn())) { break; } */ if(!(i < t.rtype.NumIn())) { $s = 21; continue; }
					_r$3 = haveIdenticalType(t.rtype.In(i), v.rtype.In(i), cmpTags); /* */ $s = 24; case 24: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
					/* */ if (!_r$3) { $s = 22; continue; }
					/* */ $s = 23; continue;
					/* if (!_r$3) { */ case 22:
						$s = -1; return false;
					/* } */ case 23:
					i = i + (1) >> 0;
				$s = 20; continue;
				case 21:
				i$1 = 0;
				/* while (true) { */ case 25:
					/* if (!(i$1 < t.rtype.NumOut())) { break; } */ if(!(i$1 < t.rtype.NumOut())) { $s = 26; continue; }
					_r$4 = haveIdenticalType(t.rtype.Out(i$1), v.rtype.Out(i$1), cmpTags); /* */ $s = 29; case 29: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
					/* */ if (!_r$4) { $s = 27; continue; }
					/* */ $s = 28; continue;
					/* if (!_r$4) { */ case 27:
						$s = -1; return false;
					/* } */ case 28:
					i$1 = i$1 + (1) >> 0;
				$s = 25; continue;
				case 26:
				$s = -1; return true;
			/* } else if (_1 === (20)) { */ case 5:
				t$1 = (T.kindType);
				v$1 = (V.kindType);
				if ((t$1.methods.$length === 0) && (v$1.methods.$length === 0)) {
					$s = -1; return true;
				}
				$s = -1; return false;
			/* } else if (_1 === (21)) { */ case 6:
				_r$5 = haveIdenticalType(T.Key(), V.Key(), cmpTags); /* */ $s = 31; case 31: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
				if (!(_r$5)) { _v$3 = false; $s = 30; continue s; }
				_r$6 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 32; case 32: if($c) { $c = false; _r$6 = _r$6.$blk(); } if (_r$6 && _r$6.$blk !== undefined) { break s; }
				_v$3 = _r$6; case 30:
				$24r$2 = _v$3;
				$s = 33; case 33: return $24r$2;
			/* } else if ((_1 === (22)) || (_1 === (23))) { */ case 7:
				_r$7 = haveIdenticalType(T.Elem(), V.Elem(), cmpTags); /* */ $s = 34; case 34: if($c) { $c = false; _r$7 = _r$7.$blk(); } if (_r$7 && _r$7.$blk !== undefined) { break s; }
				$24r$3 = _r$7;
				$s = 35; case 35: return $24r$3;
			/* } else if (_1 === (25)) { */ case 8:
				t$2 = (T.kindType);
				v$2 = (V.kindType);
				if (!((t$2.fields.$length === v$2.fields.$length))) {
					$s = -1; return false;
				}
				if (!($clone(t$2.pkgPath, name).name() === $clone(v$2.pkgPath, name).name())) {
					$s = -1; return false;
				}
				_ref = t$2.fields;
				_i = 0;
				/* while (true) { */ case 36:
					/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 37; continue; }
					i$2 = _i;
					tf = (x = t$2.fields, ((i$2 < 0 || i$2 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i$2]));
					vf = (x$1 = v$2.fields, ((i$2 < 0 || i$2 >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i$2]));
					if (!($clone(tf.name, name).name() === $clone(vf.name, name).name())) {
						$s = -1; return false;
					}
					_r$8 = haveIdenticalType(tf.typ, vf.typ, cmpTags); /* */ $s = 40; case 40: if($c) { $c = false; _r$8 = _r$8.$blk(); } if (_r$8 && _r$8.$blk !== undefined) { break s; }
					/* */ if (!_r$8) { $s = 38; continue; }
					/* */ $s = 39; continue;
					/* if (!_r$8) { */ case 38:
						$s = -1; return false;
					/* } */ case 39:
					if (cmpTags && !($clone(tf.name, name).tag() === $clone(vf.name, name).tag())) {
						$s = -1; return false;
					}
					if (!((tf.offset === vf.offset))) {
						$s = -1; return false;
					}
					if (!(tf.embedded() === vf.embedded())) {
						$s = -1; return false;
					}
					_i++;
				$s = 36; continue;
				case 37:
				$s = -1; return true;
			/* } */ case 9:
		case 1:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: haveIdenticalUnderlyingType, $c: true, $r, $24r, $24r$1, $24r$2, $24r$3, T, V, _1, _i, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _r$6, _r$7, _r$8, _ref, _v, _v$1, _v$2, _v$3, cmpTags, i, i$1, i$2, kind, t, t$1, t$2, tf, v, v$1, v$2, vf, x, x$1, $s};return $f;
	};
	toType = function(t) {
		var t;
		if (t === ptrType$1.nil) {
			return $ifaceNil;
		}
		return t;
	};
	ifaceIndir = function(t) {
		var t;
		return ((t.kind & 32) >>> 0) === 0;
	};
	Value.ptr.prototype.object = function() {
		var _1, newVal, v, val;
		v = this;
		if ((v.typ.Kind() === 17) || (v.typ.Kind() === 25)) {
			return v.ptr;
		}
		if (!((((v.flag & 128) >>> 0) === 0))) {
			val = v.ptr.$get();
			if (!(val === $ifaceNil) && !(val.constructor === jsType(v.typ))) {
				switch (0) { default:
					_1 = v.typ.Kind();
					if ((_1 === (11)) || (_1 === (6))) {
						val = new (jsType(v.typ))(val.$high, val.$low);
					} else if ((_1 === (15)) || (_1 === (16))) {
						val = new (jsType(v.typ))(val.$real, val.$imag);
					} else if (_1 === (23)) {
						if (val === val.constructor.nil) {
							val = jsType(v.typ).nil;
							break;
						}
						newVal = new (jsType(v.typ))(val.$array);
						newVal.$offset = val.$offset;
						newVal.$length = val.$length;
						newVal.$capacity = val.$capacity;
						val = newVal;
					}
				}
			}
			return val;
		}
		return v.ptr;
	};
	Value.prototype.object = function() { return this.$val.object(); };
	Value.ptr.prototype.assignTo = function(context, dst, target) {
		var {_r, _r$1, _r$2, context, dst, fl, target, v, x, $s, $r, $c} = $restore(this, {context, dst, target});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue(context, $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
			_r$1 = directlyAssignable(dst, v.typ); /* */ $s = 8; case 8: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (_r$1) { $s = 5; continue; }
			/* */ if (implements$1(dst, v.typ)) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (_r$1) { */ case 5:
				fl = (((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0;
				fl = (fl | (((dst.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(dst, v.ptr, fl);
			/* } else if (implements$1(dst, v.typ)) { */ case 6:
				if (target === 0) {
					target = unsafe_New(dst);
				}
				_r$2 = valueInterface($clone(v, Value)); /* */ $s = 9; case 9: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				x = _r$2;
				if (dst.NumMethod() === 0) {
					(target).$set(x);
				} else {
					ifaceE2I(dst, x, target);
				}
				$s = -1; return new Value.ptr(dst, target, 148);
			/* } */ case 7:
		case 4:
		$panic(new $String(context + ": value of type " + v.typ.String() + " is not assignable to type " + dst.String()));
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.assignTo, $c: true, $r, _r, _r$1, _r$2, context, dst, fl, target, v, x, $s};return $f;
	};
	Value.prototype.assignTo = function(context, dst, target) { return this.$val.assignTo(context, dst, target); };
	Value.ptr.prototype.Cap = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if (_1 === (17)) {
			return v.typ.Len();
		} else if ((_1 === (18)) || (_1 === (23))) {
			return $parseInt($clone(v, Value).object().$capacity) >> 0;
		}
		$panic(new ValueError.ptr("reflect.Value.Cap", k));
	};
	Value.prototype.Cap = function() { return this.$val.Cap(); };
	Value.ptr.prototype.Index = function(i) {
		var {$24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		a = [a];
		a$1 = [a$1];
		c = [c];
		i = [i];
		typ = [typ];
		typ$1 = [typ$1];
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				tt = (v.typ.kindType);
				if (i[0] < 0 || i[0] > ((tt.len >> 0))) {
					$panic(new $String("reflect: array index out of range"));
				}
				typ[0] = tt.elem;
				fl = (((((v.flag & 384) >>> 0) | new flag(v.flag).ro()) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
				a[0] = v.ptr;
				/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 7:
					$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ[0], a[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a[0][i[0]] = unwrapJsObject(typ[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl);
				/* } */ case 8:
				_r = makeValue(typ[0], wrapJsObject(typ[0], a[0][i[0]]), fl); /* */ $s = 9; case 9: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 10; case 10: return $24r;
			/* } else if (_1 === (23)) { */ case 3:
				s = $clone(v, Value).object();
				if (i[0] < 0 || i[0] >= ($parseInt(s.$length) >> 0)) {
					$panic(new $String("reflect: slice index out of range"));
				}
				tt$1 = (v.typ.kindType);
				typ$1[0] = tt$1.elem;
				fl$1 = (((384 | new flag(v.flag).ro()) >>> 0) | ((typ$1[0].Kind() >>> 0))) >>> 0;
				i[0] = i[0] + (($parseInt(s.$offset) >> 0)) >> 0;
				a$1[0] = s.$array;
				/* */ if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { $s = 11; continue; }
				/* */ $s = 12; continue;
				/* if (!((((fl$1 & 128) >>> 0) === 0)) && !((typ$1[0].Kind() === 17)) && !((typ$1[0].Kind() === 25))) { */ case 11:
					$s = -1; return new Value.ptr(typ$1[0], (new (jsType(PtrTo(typ$1[0])))((function(a, a$1, c, i, typ, typ$1) { return function() {
						return wrapJsObject(typ$1[0], a$1[0][i[0]]);
					}; })(a, a$1, c, i, typ, typ$1), (function(a, a$1, c, i, typ, typ$1) { return function(x) {
						var x;
						a$1[0][i[0]] = unwrapJsObject(typ$1[0], x);
					}; })(a, a$1, c, i, typ, typ$1))), fl$1);
				/* } */ case 12:
				_r$1 = makeValue(typ$1[0], wrapJsObject(typ$1[0], a$1[0][i[0]]), fl$1); /* */ $s = 13; case 13: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 14; case 14: return $24r$1;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i[0] < 0 || i[0] >= str.length) {
					$panic(new $String("reflect: string index out of range"));
				}
				fl$2 = (((new flag(v.flag).ro() | 8) >>> 0) | 128) >>> 0;
				c[0] = str.charCodeAt(i[0]);
				$s = -1; return new Value.ptr(uint8Type, ((c.$ptr || (c.$ptr = new ptrType$6(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, c)))), fl$2);
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Index", k));
			/* } */ case 6:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Index, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, a, a$1, c, fl, fl$1, fl$2, i, k, s, str, tt, tt$1, typ, typ$1, v, $s};return $f;
	};
	Value.prototype.Index = function(i) { return this.$val.Index(i); };
	Value.ptr.prototype.InterfaceData = function() {
		var v;
		v = this;
		$panic(new $String("InterfaceData is not supported by GopherJS"));
	};
	Value.prototype.InterfaceData = function() { return this.$val.InterfaceData(); };
	Value.ptr.prototype.IsNil = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (22)) || (_1 === (23))) {
			return $clone(v, Value).object() === jsType(v.typ).nil;
		} else if (_1 === (18)) {
			return $clone(v, Value).object() === $chanNil;
		} else if (_1 === (19)) {
			return $clone(v, Value).object() === $throwNilPointerError;
		} else if (_1 === (21)) {
			return $clone(v, Value).object() === false;
		} else if (_1 === (20)) {
			return $clone(v, Value).object() === $ifaceNil;
		} else if (_1 === (26)) {
			return $clone(v, Value).object() === 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.IsNil", k));
		}
	};
	Value.prototype.IsNil = function() { return this.$val.IsNil(); };
	Value.ptr.prototype.Len = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (17)) || (_1 === (24))) {
			return $parseInt($clone(v, Value).object().length);
		} else if (_1 === (23)) {
			return $parseInt($clone(v, Value).object().$length) >> 0;
		} else if (_1 === (18)) {
			return $parseInt($clone(v, Value).object().$buffer.length) >> 0;
		} else if (_1 === (21)) {
			return $parseInt($clone(v, Value).object().size) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Len", k));
		}
	};
	Value.prototype.Len = function() { return this.$val.Len(); };
	Value.ptr.prototype.Pointer = function() {
		var _1, k, v;
		v = this;
		k = new flag(v.flag).kind();
		_1 = k;
		if ((_1 === (18)) || (_1 === (21)) || (_1 === (22)) || (_1 === (26))) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object();
		} else if (_1 === (19)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return 1;
		} else if (_1 === (23)) {
			if ($clone(v, Value).IsNil()) {
				return 0;
			}
			return $clone(v, Value).object().$array;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Pointer", k));
		}
	};
	Value.prototype.Pointer = function() { return this.$val.Pointer(); };
	Value.ptr.prototype.Set = function(x) {
		var {_1, _r, _r$1, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(x.flag).mustBeExported();
		_r = $clone(x, Value).assignTo("reflect.Set", v.typ, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(x, _r);
		/* */ if (!((((v.flag & 128) >>> 0) === 0))) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (!((((v.flag & 128) >>> 0) === 0))) { */ case 2:
				_1 = v.typ.Kind();
				/* */ if (_1 === (17)) { $s = 5; continue; }
				/* */ if (_1 === (20)) { $s = 6; continue; }
				/* */ if (_1 === (25)) { $s = 7; continue; }
				/* */ $s = 8; continue;
				/* if (_1 === (17)) { */ case 5:
					jsType(v.typ).copy(v.ptr, x.ptr);
					$s = 9; continue;
				/* } else if (_1 === (20)) { */ case 6:
					_r$1 = valueInterface($clone(x, Value)); /* */ $s = 10; case 10: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					v.ptr.$set(_r$1);
					$s = 9; continue;
				/* } else if (_1 === (25)) { */ case 7:
					copyStruct(v.ptr, x.ptr, v.typ);
					$s = 9; continue;
				/* } else { */ case 8:
					v.ptr.$set($clone(x, Value).object());
				/* } */ case 9:
			case 4:
			$s = -1; return;
		/* } */ case 3:
		v.ptr = x.ptr;
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Set, $c: true, $r, _1, _r, _r$1, v, x, $s};return $f;
	};
	Value.prototype.Set = function(x) { return this.$val.Set(x); };
	Value.ptr.prototype.SetBytes = function(x) {
		var {_r, _r$1, _v, slice, typedSlice, v, x, $s, $r, $c} = $restore(this, {x});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		_r = v.typ.Elem().Kind(); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (!((_r === 8))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((_r === 8))) { */ case 1:
			$panic(new $String("reflect.Value.SetBytes of non-byte slice"));
		/* } */ case 2:
		slice = x;
		if (!(v.typ.Name() === "")) { _v = true; $s = 6; continue s; }
		_r$1 = v.typ.Elem().Name(); /* */ $s = 7; case 7: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_v = !(_r$1 === ""); case 6:
		/* */ if (_v) { $s = 4; continue; }
		/* */ $s = 5; continue;
		/* if (_v) { */ case 4:
			typedSlice = new (jsType(v.typ))(slice.$array);
			typedSlice.$offset = slice.$offset;
			typedSlice.$length = slice.$length;
			typedSlice.$capacity = slice.$capacity;
			slice = typedSlice;
		/* } */ case 5:
		v.ptr.$set(slice);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.SetBytes, $c: true, $r, _r, _r$1, _v, slice, typedSlice, v, x, $s};return $f;
	};
	Value.prototype.SetBytes = function(x) { return this.$val.SetBytes(x); };
	Value.ptr.prototype.SetCap = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < ($parseInt(s.$length) >> 0) || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice capacity out of range in SetCap"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = s.$length;
		newSlice.$capacity = n;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetCap = function(n) { return this.$val.SetCap(n); };
	Value.ptr.prototype.SetLen = function(n) {
		var n, newSlice, s, v;
		v = this;
		new flag(v.flag).mustBeAssignable();
		new flag(v.flag).mustBe(23);
		s = v.ptr.$get();
		if (n < 0 || n > ($parseInt(s.$capacity) >> 0)) {
			$panic(new $String("reflect: slice length out of range in SetLen"));
		}
		newSlice = new (jsType(v.typ))(s.$array);
		newSlice.$offset = s.$offset;
		newSlice.$length = n;
		newSlice.$capacity = s.$capacity;
		v.ptr.$set(newSlice);
	};
	Value.prototype.SetLen = function(n) { return this.$val.SetLen(n); };
	Value.ptr.prototype.Slice = function(i, j) {
		var {$24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s, $r, $c} = $restore(this, {i, j});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
			kind = new flag(v.flag).kind();
			_1 = kind;
			/* */ if (_1 === (17)) { $s = 2; continue; }
			/* */ if (_1 === (23)) { $s = 3; continue; }
			/* */ if (_1 === (24)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if (_1 === (17)) { */ case 2:
				if (((v.flag & 256) >>> 0) === 0) {
					$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
				}
				tt = (v.typ.kindType);
				cap = ((tt.len >> 0));
				typ = SliceOf(tt.elem);
				s = new (jsType(typ))($clone(v, Value).object());
				$s = 6; continue;
			/* } else if (_1 === (23)) { */ case 3:
				typ = v.typ;
				s = $clone(v, Value).object();
				cap = $parseInt(s.$capacity) >> 0;
				$s = 6; continue;
			/* } else if (_1 === (24)) { */ case 4:
				str = (v.ptr).$get();
				if (i < 0 || j < i || j > str.length) {
					$panic(new $String("reflect.Value.Slice: string slice index out of bounds"));
				}
				_r = ValueOf(new $String($substring(str, i, j))); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 8; case 8: return $24r;
			/* } else { */ case 5:
				$panic(new ValueError.ptr("reflect.Value.Slice", kind));
			/* } */ case 6:
		case 1:
		if (i < 0 || j < i || j > cap) {
			$panic(new $String("reflect.Value.Slice: slice index out of bounds"));
		}
		_r$1 = makeValue(typ, $subslice(s, i, j), new flag(v.flag).ro()); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r$1 = _r$1;
		$s = 10; case 10: return $24r$1;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice, $c: true, $r, $24r, $24r$1, _1, _r, _r$1, cap, i, j, kind, s, str, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice = function(i, j) { return this.$val.Slice(i, j); };
	Value.ptr.prototype.Slice3 = function(i, j, k) {
		var {$24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s, $r, $c} = $restore(this, {i, j, k});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		cap = 0;
		typ = $ifaceNil;
		s = null;
		kind = new flag(v.flag).kind();
		_1 = kind;
		if (_1 === (17)) {
			if (((v.flag & 256) >>> 0) === 0) {
				$panic(new $String("reflect.Value.Slice: slice of unaddressable array"));
			}
			tt = (v.typ.kindType);
			cap = ((tt.len >> 0));
			typ = SliceOf(tt.elem);
			s = new (jsType(typ))($clone(v, Value).object());
		} else if (_1 === (23)) {
			typ = v.typ;
			s = $clone(v, Value).object();
			cap = $parseInt(s.$capacity) >> 0;
		} else {
			$panic(new ValueError.ptr("reflect.Value.Slice3", kind));
		}
		if (i < 0 || j < i || k < j || k > cap) {
			$panic(new $String("reflect.Value.Slice3: slice index out of bounds"));
		}
		_r = makeValue(typ, $subslice(s, i, j, k), new flag(v.flag).ro()); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Slice3, $c: true, $r, $24r, _1, _r, cap, i, j, k, kind, s, tt, typ, v, $s};return $f;
	};
	Value.prototype.Slice3 = function(i, j, k) { return this.$val.Slice3(i, j, k); };
	Value.ptr.prototype.Close = function() {
		var v;
		v = this;
		new flag(v.flag).mustBe(18);
		new flag(v.flag).mustBeExported();
		$close($clone(v, Value).object());
	};
	Value.prototype.Close = function() { return this.$val.Close(); };
	Value.ptr.prototype.Elem = function() {
		var {$24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
			k = new flag(v.flag).kind();
			_1 = k;
			/* */ if (_1 === (20)) { $s = 2; continue; }
			/* */ if (_1 === (22)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_1 === (20)) { */ case 2:
				val = $clone(v, Value).object();
				if (val === $ifaceNil) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				typ = reflectType(val.constructor);
				_r = makeValue(typ, val.$val, new flag(v.flag).ro()); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (22)) { */ case 3:
				if ($clone(v, Value).IsNil()) {
					$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
				}
				val$1 = $clone(v, Value).object();
				tt = (v.typ.kindType);
				fl = (((((v.flag & 96) >>> 0) | 128) >>> 0) | 256) >>> 0;
				fl = (fl | (((tt.elem.Kind() >>> 0)))) >>> 0;
				$s = -1; return new Value.ptr(tt.elem, (wrapJsObject(tt.elem, val$1)), fl);
			/* } else { */ case 4:
				$panic(new ValueError.ptr("reflect.Value.Elem", k));
			/* } */ case 5:
		case 1:
		$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Elem, $c: true, $r, $24r, _1, _r, fl, k, tt, typ, v, val, val$1, $s};return $f;
	};
	Value.prototype.Elem = function() { return this.$val.Elem(); };
	Value.ptr.prototype.NumField = function() {
		var tt, v;
		v = this;
		new flag(v.flag).mustBe(25);
		tt = (v.typ.kindType);
		return tt.fields.$length;
	};
	Value.prototype.NumField = function() { return this.$val.NumField(); };
	Value.ptr.prototype.MapKeys = function() {
		var {_r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		keyType = tt.key;
		fl = (new flag(v.flag).ro() | ((keyType.Kind() >>> 0))) >>> 0;
		m = $clone(v, Value).pointer();
		mlen = 0;
		if (!(m === 0)) {
			mlen = maplen(m);
		}
		it = mapiterinit(v.typ, m);
		a = $makeSlice(sliceType$6, mlen);
		i = 0;
		i = 0;
		/* while (true) { */ case 1:
			/* if (!(i < a.$length)) { break; } */ if(!(i < a.$length)) { $s = 2; continue; }
			_r = mapiterkey(it); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			key = _r;
			if (key === 0) {
				/* break; */ $s = 2; continue;
			}
			Value.copy(((i < 0 || i >= a.$length) ? ($throwRuntimeError("index out of range"), undefined) : a.$array[a.$offset + i]), copyVal(keyType, fl, key));
			mapiternext(it);
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return $subslice(a, 0, i);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapKeys, $c: true, $r, _r, a, fl, i, it, key, keyType, m, mlen, tt, v, $s};return $f;
	};
	Value.prototype.MapKeys = function() { return this.$val.MapKeys(); };
	Value.ptr.prototype.MapIndex = function(key) {
		var {_r, e, fl, k, key, tt, typ, v, $s, $r, $c} = $restore(this, {key});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		v = this;
		new flag(v.flag).mustBe(21);
		tt = (v.typ.kindType);
		_r = $clone(key, Value).assignTo("reflect.Value.MapIndex", tt.key, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		Value.copy(key, _r);
		k = 0;
		if (!((((key.flag & 128) >>> 0) === 0))) {
			k = key.ptr;
		} else {
			k = ((key.$ptr_ptr || (key.$ptr_ptr = new ptrType$7(function() { return this.$target.ptr; }, function($v) { this.$target.ptr = $v; }, key))));
		}
		e = mapaccess(v.typ, $clone(v, Value).pointer(), k);
		if (e === 0) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		typ = tt.elem;
		fl = new flag((((v.flag | key.flag) >>> 0))).ro();
		fl = (fl | (((typ.Kind() >>> 0)))) >>> 0;
		$s = -1; return copyVal(typ, fl, e);
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.MapIndex, $c: true, $r, _r, e, fl, k, key, tt, typ, v, $s};return $f;
	};
	Value.prototype.MapIndex = function(key) { return this.$val.MapIndex(key); };
	Value.ptr.prototype.Field = function(i) {
		var {$24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		jsTag = [jsTag];
		prop = [prop];
		s = [s];
		typ = [typ];
		v = this;
		if (!((new flag(v.flag).kind() === 25))) {
			$panic(new ValueError.ptr("reflect.Value.Field", new flag(v.flag).kind()));
		}
		tt = (v.typ.kindType);
		if (((i >>> 0)) >= ((tt.fields.$length >>> 0))) {
			$panic(new $String("reflect: Field index out of range"));
		}
		prop[0] = $internalize(jsType(v.typ).fields[i].prop, $String);
		field = (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
		typ[0] = field.typ;
		fl = (((v.flag & 416) >>> 0) | ((typ[0].Kind() >>> 0))) >>> 0;
		if (!$clone(field.name, name).isExported()) {
			if (field.embedded()) {
				fl = (fl | (64)) >>> 0;
			} else {
				fl = (fl | (32)) >>> 0;
			}
		}
		tag = $clone((x$1 = tt.fields, ((i < 0 || i >= x$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : x$1.$array[x$1.$offset + i])).name, name).tag();
		/* */ if (!(tag === "") && !((i === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!(tag === "") && !((i === 0))) { */ case 1:
			jsTag[0] = getJsTag(tag);
			/* */ if (!(jsTag[0] === "")) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(jsTag[0] === "")) { */ case 3:
				/* while (true) { */ case 5:
					o = [o];
					_r = $clone(v, Value).Field(0); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
					Value.copy(v, _r);
					/* */ if (v.typ === jsObjectPtr) { $s = 8; continue; }
					/* */ $s = 9; continue;
					/* if (v.typ === jsObjectPtr) { */ case 8:
						o[0] = $clone(v, Value).object().object;
						$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, o, prop, s, typ) { return function() {
							return $internalize(o[0][$externalize(jsTag[0], $String)], jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ), (function(jsTag, o, prop, s, typ) { return function(x$2) {
							var x$2;
							o[0][$externalize(jsTag[0], $String)] = $externalize(x$2, jsType(typ[0]));
						}; })(jsTag, o, prop, s, typ))), fl);
					/* } */ case 9:
					/* */ if (v.typ.Kind() === 22) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (v.typ.Kind() === 22) { */ case 10:
						_r$1 = $clone(v, Value).Elem(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
						Value.copy(v, _r$1);
					/* } */ case 11:
				$s = 5; continue;
				case 6:
			/* } */ case 4:
		/* } */ case 2:
		s[0] = v.ptr;
		/* */ if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { $s = 13; continue; }
		/* */ $s = 14; continue;
		/* if (!((((fl & 128) >>> 0) === 0)) && !((typ[0].Kind() === 17)) && !((typ[0].Kind() === 25))) { */ case 13:
			$s = -1; return new Value.ptr(typ[0], (new (jsType(PtrTo(typ[0])))((function(jsTag, prop, s, typ) { return function() {
				return wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]);
			}; })(jsTag, prop, s, typ), (function(jsTag, prop, s, typ) { return function(x$2) {
				var x$2;
				s[0][$externalize(prop[0], $String)] = unwrapJsObject(typ[0], x$2);
			}; })(jsTag, prop, s, typ))), fl);
		/* } */ case 14:
		_r$2 = makeValue(typ[0], wrapJsObject(typ[0], s[0][$externalize(prop[0], $String)]), fl); /* */ $s = 15; case 15: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = _r$2;
		$s = 16; case 16: return $24r;
		/* */ } return; } var $f = {$blk: Value.ptr.prototype.Field, $c: true, $r, $24r, _r, _r$1, _r$2, field, fl, i, jsTag, o, prop, s, tag, tt, typ, v, x, x$1, $s};return $f;
	};
	Value.prototype.Field = function(i) { return this.$val.Field(i); };
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	unquote = function(s) {
		var s;
		if (s.length < 2) {
			return [s, $ifaceNil];
		}
		if ((s.charCodeAt(0) === 39) || (s.charCodeAt(0) === 34)) {
			if (s.charCodeAt((s.length - 1 >> 0)) === s.charCodeAt(0)) {
				return [$substring(s, 1, (s.length - 1 >> 0)), $ifaceNil];
			}
			return ["", $pkg.ErrSyntax];
		}
		return [s, $ifaceNil];
	};
	flag.prototype.mustBe = function(expected) {
		var expected, f;
		f = this.$val;
		if (!((((((f & 31) >>> 0) >>> 0)) === expected))) {
			$panic(new ValueError.ptr(methodName(), new flag(f).kind()));
		}
	};
	$ptrType(flag).prototype.mustBe = function(expected) { return new flag(this.$get()).mustBe(expected); };
	rtype.ptr.prototype.Comparable = function() {
		var {$24r, _1, _r, _r$1, ft, i, t, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		t = this;
			_1 = t.Kind();
			/* */ if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { $s = 2; continue; }
			/* */ if (_1 === (17)) { $s = 3; continue; }
			/* */ if (_1 === (25)) { $s = 4; continue; }
			/* */ $s = 5; continue;
			/* if ((_1 === (19)) || (_1 === (23)) || (_1 === (21))) { */ case 2:
				$s = -1; return false;
			/* } else if (_1 === (17)) { */ case 3:
				_r = t.Elem().Comparable(); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 7; case 7: return $24r;
			/* } else if (_1 === (25)) { */ case 4:
				i = 0;
				/* while (true) { */ case 8:
					/* if (!(i < t.NumField())) { break; } */ if(!(i < t.NumField())) { $s = 9; continue; }
					ft = $clone(t.Field(i), structField);
					_r$1 = ft.typ.Comparable(); /* */ $s = 12; case 12: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 10; continue; }
					/* */ $s = 11; continue;
					/* if (!_r$1) { */ case 10:
						$s = -1; return false;
					/* } */ case 11:
					i = i + (1) >> 0;
				$s = 8; continue;
				case 9:
			/* } */ case 5:
		case 1:
		$s = -1; return true;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Comparable, $c: true, $r, $24r, _1, _r, _r$1, ft, i, t, $s};return $f;
	};
	rtype.prototype.Comparable = function() { return this.$val.Comparable(); };
	rtype.ptr.prototype.IsVariadic = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 19))) {
			$panic(new $String("reflect: IsVariadic of non-func type"));
		}
		tt = (t.kindType);
		return !((((tt.outCount & 32768) >>> 0) === 0));
	};
	rtype.prototype.IsVariadic = function() { return this.$val.IsVariadic(); };
	rtype.ptr.prototype.Field = function(i) {
		var i, t, tt, x;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: Field of non-struct type"));
		}
		tt = (t.kindType);
		if (i < 0 || i >= tt.fields.$length) {
			$panic(new $String("reflect: Field index out of bounds"));
		}
		return (x = tt.fields, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
	};
	rtype.prototype.Field = function(i) { return this.$val.Field(i); };
	rtype.ptr.prototype.Key = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 21))) {
			$panic(new $String("reflect: Key of non-map type"));
		}
		tt = (t.kindType);
		return toType(tt.key);
	};
	rtype.prototype.Key = function() { return this.$val.Key(); };
	rtype.ptr.prototype.NumField = function() {
		var t, tt;
		t = this;
		if (!((t.Kind() === 25))) {
			$panic(new $String("reflect: NumField of non-struct type"));
		}
		tt = (t.kindType);
		return tt.fields.$length;
	};
	rtype.prototype.NumField = function() { return this.$val.NumField(); };
	rtype.ptr.prototype.Method = function(i) {
		var {$24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		prop = [prop];
		m = new Method.ptr("", "", $ifaceNil, new Value.ptr(ptrType$1.nil, 0, 0), 0);
		t = this;
		/* */ if (t.Kind() === 20) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (t.Kind() === 20) { */ case 1:
			tt = (t.kindType);
			_r = tt.rtype.Method(i); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Method.copy(m, _r);
			$24r = m;
			$s = 4; case 4: return $24r;
		/* } */ case 2:
		methods = t.exportedMethods();
		if (i < 0 || i >= methods.$length) {
			$panic(new $String("reflect: Method index out of range"));
		}
		p = $clone(((i < 0 || i >= methods.$length) ? ($throwRuntimeError("index out of range"), undefined) : methods.$array[methods.$offset + i]), method);
		pname = $clone(t.nameOff(p.name), name);
		m.Name = $clone(pname, name).name();
		fl = 19;
		mtyp = t.typeOff(p.mtyp);
		ft = (mtyp.kindType);
		in$1 = $makeSlice(sliceType$7, 0, (1 + ft.in$().$length >> 0));
		in$1 = $append(in$1, t);
		_ref = ft.in$();
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			arg = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			in$1 = $append(in$1, arg);
			_i++;
		}
		out = $makeSlice(sliceType$7, 0, ft.out().$length);
		_ref$1 = ft.out();
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			ret = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			out = $append(out, ret);
			_i$1++;
		}
		_r$1 = FuncOf(in$1, out, ft.rtype.IsVariadic()); /* */ $s = 5; case 5: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		mt = _r$1;
		m.Type = mt;
		prop[0] = $internalize($methodSet(t[$externalize(idJsType, $String)])[i].prop, $String);
		fn = js.MakeFunc((function(prop) { return function(this$1, arguments$1) {
			var arguments$1, rcvr, this$1;
			rcvr = (0 >= arguments$1.$length ? ($throwRuntimeError("index out of range"), undefined) : arguments$1.$array[arguments$1.$offset + 0]);
			return new $jsObjectPtr(rcvr[$externalize(prop[0], $String)].apply(rcvr, $externalize($subslice(arguments$1, 1), sliceType$8)));
		}; })(prop));
		Value.copy(m.Func, new Value.ptr($assertType(mt, ptrType$1), (fn), fl));
		m.Index = i;
		Method.copy(m, m);
		$s = -1; return m;
		/* */ } return; } var $f = {$blk: rtype.ptr.prototype.Method, $c: true, $r, $24r, _i, _i$1, _r, _r$1, _ref, _ref$1, arg, fl, fn, ft, i, in$1, m, methods, mt, mtyp, out, p, pname, prop, ret, t, tt, $s};return $f;
	};
	rtype.prototype.Method = function(i) { return this.$val.Method(i); };
	Swapper = function(slice) {
		var {_1, _r, a, off, slice, v, vLen, $s, $r, $c} = $restore(this, {slice});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		a = [a];
		off = [off];
		vLen = [vLen];
		_r = ValueOf(slice); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		v = $clone(_r, Value);
		if (!(($clone(v, Value).Kind() === 23))) {
			$panic(new ValueError.ptr("Swapper", $clone(v, Value).Kind()));
		}
		vLen[0] = (($clone(v, Value).Len() >>> 0));
		_1 = vLen[0];
		if (_1 === (0)) {
			$s = -1; return (function(a, off, vLen) { return function(i, j) {
				var i, j;
				$panic(new $String("reflect: slice index out of range"));
			}; })(a, off, vLen);
		} else if (_1 === (1)) {
			$s = -1; return (function(a, off, vLen) { return function(i, j) {
				var i, j;
				if (!((i === 0)) || !((j === 0))) {
					$panic(new $String("reflect: slice index out of range"));
				}
			}; })(a, off, vLen);
		}
		a[0] = slice.$array;
		off[0] = $parseInt(slice.$offset) >> 0;
		$s = -1; return (function(a, off, vLen) { return function(i, j) {
			var i, j, tmp;
			if (((i >>> 0)) >= vLen[0] || ((j >>> 0)) >= vLen[0]) {
				$panic(new $String("reflect: slice index out of range"));
			}
			i = i + (off[0]) >> 0;
			j = j + (off[0]) >> 0;
			tmp = a[0][i];
			a[0][i] = a[0][j];
			a[0][j] = tmp;
		}; })(a, off, vLen);
		/* */ } return; } var $f = {$blk: Swapper, $c: true, $r, _1, _r, a, off, slice, v, vLen, $s};return $f;
	};
	$pkg.Swapper = Swapper;
	init = function() {
		var {used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		used = (function(i) {
			var i;
		});
		$r = used((x = new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new x.constructor.elem(x))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$1 = new uncommonType.ptr(0, 0, 0, 0, sliceType$5.nil), new x$1.constructor.elem(x$1))); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$2 = new method.ptr(0, 0, 0, 0), new x$2.constructor.elem(x$2))); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$3 = new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, 0), new x$3.constructor.elem(x$3))); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$4 = new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, 0), new x$4.constructor.elem(x$4))); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$5 = new funcType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), 0, 0, sliceType$2.nil, sliceType$2.nil), new x$5.constructor.elem(x$5))); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$6 = new interfaceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$9.nil), new x$6.constructor.elem(x$6))); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$7 = new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil, ptrType$1.nil, ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0), new x$7.constructor.elem(x$7))); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$8 = new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$8.constructor.elem(x$8))); /* */ $s = 9; case 9: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$9 = new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), ptrType$1.nil), new x$9.constructor.elem(x$9))); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$10 = new structType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), new name.ptr(ptrType$6.nil), sliceType$10.nil), new x$10.constructor.elem(x$10))); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$11 = new imethod.ptr(0, 0), new x$11.constructor.elem(x$11))); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = used((x$12 = new structField.ptr(new name.ptr(ptrType$6.nil), ptrType$1.nil, 0), new x$12.constructor.elem(x$12))); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		initialized = true;
		uint8Type = $assertType(TypeOf(new $Uint8(0)), ptrType$1);
		$s = -1; return;
		/* */ } return; } var $f = {$blk: init, $c: true, $r, used, x, x$1, x$10, x$11, x$12, x$2, x$3, x$4, x$5, x$6, x$7, x$8, x$9, $s};return $f;
	};
	jsType = function(typ) {
		var typ;
		return typ[$externalize(idJsType, $String)];
	};
	reflectType = function(typ) {
		var _1, _i, _i$1, _i$2, _i$3, _key, _ref, _ref$1, _ref$2, _ref$3, dir, exported, exported$1, f, fields, i, i$1, i$2, i$3, i$4, i$5, imethods, in$1, m, m$1, m$2, methodSet, methods, out, outCount, params, reflectFields, reflectMethods, results, rt, typ, ut, xcount;
		if (typ[$externalize(idReflectType, $String)] === undefined) {
			rt = new rtype.ptr(((($parseInt(typ.size) >> 0) >>> 0)), 0, 0, 0, 0, 0, ((($parseInt(typ.kind) >> 0) << 24 >>> 24)), $throwNilPointerError, ptrType$6.nil, newNameOff($clone(newName(internalStr(typ.string), "", !!(typ.exported), false), name)), 0);
			rt[$externalize(idJsType, $String)] = typ;
			typ[$externalize(idReflectType, $String)] = rt;
			methodSet = $methodSet(typ);
			if (!(($parseInt(methodSet.length) === 0)) || !!(typ.named)) {
				rt.tflag = (rt.tflag | (1)) >>> 0;
				if (!!(typ.named)) {
					rt.tflag = (rt.tflag | (4)) >>> 0;
				}
				reflectMethods = sliceType$5.nil;
				i = 0;
				while (true) {
					if (!(i < $parseInt(methodSet.length))) { break; }
					m = methodSet[i];
					exported = internalStr(m.pkg) === "";
					if (!exported) {
						i = i + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m.name), "", exported, false), name)), newTypeOff(reflectType(m.typ)), 0, 0));
					i = i + (1) >> 0;
				}
				xcount = ((reflectMethods.$length << 16 >>> 16));
				i$1 = 0;
				while (true) {
					if (!(i$1 < $parseInt(methodSet.length))) { break; }
					m$1 = methodSet[i$1];
					exported$1 = internalStr(m$1.pkg) === "";
					if (exported$1) {
						i$1 = i$1 + (1) >> 0;
						continue;
					}
					reflectMethods = $append(reflectMethods, new method.ptr(newNameOff($clone(newName(internalStr(m$1.name), "", exported$1, false), name)), newTypeOff(reflectType(m$1.typ)), 0, 0));
					i$1 = i$1 + (1) >> 0;
				}
				ut = new uncommonType.ptr(newNameOff($clone(newName(internalStr(typ.pkg), "", false, false), name)), (($parseInt(methodSet.length) << 16 >>> 16)), xcount, 0, reflectMethods);
				_key = rt; (uncommonTypeMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$1.keyFor(_key), { k: _key, v: ut });
				ut[$externalize(idJsType, $String)] = typ;
			}
			_1 = rt.Kind();
			if (_1 === (17)) {
				setKindType(rt, new arrayType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ptrType$1.nil, ((($parseInt(typ.len) >> 0) >>> 0))));
			} else if (_1 === (18)) {
				dir = 3;
				if (!!(typ.sendOnly)) {
					dir = 2;
				}
				if (!!(typ.recvOnly)) {
					dir = 1;
				}
				setKindType(rt, new chanType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem), ((dir >>> 0))));
			} else if (_1 === (19)) {
				params = typ.params;
				in$1 = $makeSlice(sliceType$2, $parseInt(params.length));
				_ref = in$1;
				_i = 0;
				while (true) {
					if (!(_i < _ref.$length)) { break; }
					i$2 = _i;
					((i$2 < 0 || i$2 >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + i$2] = reflectType(params[i$2]));
					_i++;
				}
				results = typ.results;
				out = $makeSlice(sliceType$2, $parseInt(results.length));
				_ref$1 = out;
				_i$1 = 0;
				while (true) {
					if (!(_i$1 < _ref$1.$length)) { break; }
					i$3 = _i$1;
					((i$3 < 0 || i$3 >= out.$length) ? ($throwRuntimeError("index out of range"), undefined) : out.$array[out.$offset + i$3] = reflectType(results[i$3]));
					_i$1++;
				}
				outCount = (($parseInt(results.length) << 16 >>> 16));
				if (!!(typ.variadic)) {
					outCount = (outCount | (32768)) >>> 0;
				}
				setKindType(rt, new funcType.ptr($clone(rt, rtype), (($parseInt(params.length) << 16 >>> 16)), outCount, in$1, out));
			} else if (_1 === (20)) {
				methods = typ.methods;
				imethods = $makeSlice(sliceType$9, $parseInt(methods.length));
				_ref$2 = imethods;
				_i$2 = 0;
				while (true) {
					if (!(_i$2 < _ref$2.$length)) { break; }
					i$4 = _i$2;
					m$2 = methods[i$4];
					imethod.copy(((i$4 < 0 || i$4 >= imethods.$length) ? ($throwRuntimeError("index out of range"), undefined) : imethods.$array[imethods.$offset + i$4]), new imethod.ptr(newNameOff($clone(newName(internalStr(m$2.name), "", internalStr(m$2.pkg) === "", false), name)), newTypeOff(reflectType(m$2.typ))));
					_i$2++;
				}
				setKindType(rt, new interfaceType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkg), "", false, false), name), imethods));
			} else if (_1 === (21)) {
				setKindType(rt, new mapType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.key), reflectType(typ.elem), ptrType$1.nil, $throwNilPointerError, 0, 0, 0, 0));
			} else if (_1 === (22)) {
				setKindType(rt, new ptrType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (23)) {
				setKindType(rt, new sliceType.ptr(new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0), reflectType(typ.elem)));
			} else if (_1 === (25)) {
				fields = typ.fields;
				reflectFields = $makeSlice(sliceType$10, $parseInt(fields.length));
				_ref$3 = reflectFields;
				_i$3 = 0;
				while (true) {
					if (!(_i$3 < _ref$3.$length)) { break; }
					i$5 = _i$3;
					f = fields[i$5];
					structField.copy(((i$5 < 0 || i$5 >= reflectFields.$length) ? ($throwRuntimeError("index out of range"), undefined) : reflectFields.$array[reflectFields.$offset + i$5]), new structField.ptr($clone(newName(internalStr(f.name), internalStr(f.tag), !!(f.exported), !!(f.embedded)), name), reflectType(f.typ), ((i$5 >>> 0))));
					_i$3++;
				}
				setKindType(rt, new structType.ptr($clone(rt, rtype), $clone(newName(internalStr(typ.pkgPath), "", false, false), name), reflectFields));
			}
		}
		return ((typ[$externalize(idReflectType, $String)]));
	};
	setKindType = function(rt, kindType) {
		var kindType, rt;
		rt[$externalize(idKindType, $String)] = kindType;
		kindType[$externalize(idRtype, $String)] = rt;
	};
	uncommonType.ptr.prototype.methods = function() {
		var t;
		t = this;
		return t._methods;
	};
	uncommonType.prototype.methods = function() { return this.$val.methods(); };
	uncommonType.ptr.prototype.exportedMethods = function() {
		var t;
		t = this;
		return $subslice(t._methods, 0, t.xcount, t.xcount);
	};
	uncommonType.prototype.exportedMethods = function() { return this.$val.exportedMethods(); };
	rtype.ptr.prototype.uncommon = function() {
		var _entry, t;
		t = this;
		return (_entry = $mapIndex(uncommonTypeMap,ptrType$1.keyFor(t)), _entry !== undefined ? _entry.v : ptrType$4.nil);
	};
	rtype.prototype.uncommon = function() { return this.$val.uncommon(); };
	funcType.ptr.prototype.in$ = function() {
		var t;
		t = this;
		return t._in;
	};
	funcType.prototype.in$ = function() { return this.$val.in$(); };
	funcType.ptr.prototype.out = function() {
		var t;
		t = this;
		return t._out;
	};
	funcType.prototype.out = function() { return this.$val.out(); };
	name.ptr.prototype.name = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).name;
		return s;
	};
	name.prototype.name = function() { return this.$val.name(); };
	name.ptr.prototype.tag = function() {
		var _entry, n, s;
		s = "";
		n = this;
		s = (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).tag;
		return s;
	};
	name.prototype.tag = function() { return this.$val.tag(); };
	name.ptr.prototype.pkgPath = function() {
		var n;
		n = this;
		return "";
	};
	name.prototype.pkgPath = function() { return this.$val.pkgPath(); };
	name.ptr.prototype.isExported = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).exported;
	};
	name.prototype.isExported = function() { return this.$val.isExported(); };
	name.ptr.prototype.embedded = function() {
		var _entry, n;
		n = this;
		return (_entry = $mapIndex(nameMap,ptrType$6.keyFor(n.bytes)), _entry !== undefined ? _entry.v : ptrType$8.nil).embedded;
	};
	name.prototype.embedded = function() { return this.$val.embedded(); };
	newName = function(n, tag, exported, embedded) {
		var _key, b, embedded, exported, n, tag;
		b = $newDataPointer(0, ptrType$6);
		_key = b; (nameMap || $throwRuntimeError("assignment to entry in nil map")).set(ptrType$6.keyFor(_key), { k: _key, v: new nameData.ptr(n, tag, exported, embedded) });
		return new name.ptr(b);
	};
	rtype.ptr.prototype.nameOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= nameOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : nameOffList.$array[nameOffList.$offset + x]));
	};
	rtype.prototype.nameOff = function(off) { return this.$val.nameOff(off); };
	newNameOff = function(n) {
		var i, n;
		i = nameOffList.$length;
		nameOffList = $append(nameOffList, n);
		return ((i >> 0));
	};
	rtype.ptr.prototype.typeOff = function(off) {
		var off, t, x;
		t = this;
		return (x = ((off >> 0)), ((x < 0 || x >= typeOffList.$length) ? ($throwRuntimeError("index out of range"), undefined) : typeOffList.$array[typeOffList.$offset + x]));
	};
	rtype.prototype.typeOff = function(off) { return this.$val.typeOff(off); };
	newTypeOff = function(t) {
		var i, t;
		i = typeOffList.$length;
		typeOffList = $append(typeOffList, t);
		return ((i >> 0));
	};
	internalStr = function(strObj) {
		var c, strObj;
		c = new structType$2.ptr("");
		c.str = strObj;
		return c.str;
	};
	isWrapped = function(typ) {
		var typ;
		return !!(jsType(typ).wrapped);
	};
	copyStruct = function(dst, src, typ) {
		var dst, fields, i, prop, src, typ;
		fields = jsType(typ).fields;
		i = 0;
		while (true) {
			if (!(i < $parseInt(fields.length))) { break; }
			prop = $internalize(fields[i].prop, $String);
			dst[$externalize(prop, $String)] = src[$externalize(prop, $String)];
			i = i + (1) >> 0;
		}
	};
	makeValue = function(t, v, fl) {
		var {$24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s, $r, $c} = $restore(this, {t, v, fl});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = t.common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rt = _r;
		_r$1 = t.Kind(); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		if (_r$1 === 17) { _v$1 = true; $s = 5; continue s; }
		_r$2 = t.Kind(); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_v$1 = _r$2 === 25; case 5:
		if (_v$1) { _v = true; $s = 4; continue s; }
		_r$3 = t.Kind(); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
		_v = _r$3 === 22; case 4:
		/* */ if (_v) { $s = 2; continue; }
		/* */ $s = 3; continue;
		/* if (_v) { */ case 2:
			_r$4 = t.Kind(); /* */ $s = 9; case 9: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			$24r = new Value.ptr(rt, (v), (fl | ((_r$4 >>> 0))) >>> 0);
			$s = 10; case 10: return $24r;
		/* } */ case 3:
		_r$5 = t.Kind(); /* */ $s = 11; case 11: if($c) { $c = false; _r$5 = _r$5.$blk(); } if (_r$5 && _r$5.$blk !== undefined) { break s; }
		$24r$1 = new Value.ptr(rt, ($newDataPointer(v, jsType(rt.ptrTo()))), (((fl | ((_r$5 >>> 0))) >>> 0) | 128) >>> 0);
		$s = 12; case 12: return $24r$1;
		/* */ } return; } var $f = {$blk: makeValue, $c: true, $r, $24r, $24r$1, _r, _r$1, _r$2, _r$3, _r$4, _r$5, _v, _v$1, fl, rt, t, v, $s};return $f;
	};
	TypeOf = function(i) {
		var i;
		if (!initialized) {
			return new rtype.ptr(0, 0, 0, 0, 0, 0, 0, $throwNilPointerError, ptrType$6.nil, 0, 0);
		}
		if ($interfaceIsEqual(i, $ifaceNil)) {
			return $ifaceNil;
		}
		return reflectType(i.constructor);
	};
	$pkg.TypeOf = TypeOf;
	ValueOf = function(i) {
		var {$24r, _r, i, $s, $r, $c} = $restore(this, {i});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if ($interfaceIsEqual(i, $ifaceNil)) {
			$s = -1; return new Value.ptr(ptrType$1.nil, 0, 0);
		}
		_r = makeValue(reflectType(i.constructor), i.$val, 0); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ValueOf, $c: true, $r, $24r, _r, i, $s};return $f;
	};
	$pkg.ValueOf = ValueOf;
	FuncOf = function(in$1, out, variadic) {
		var {_i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s, $r, $c} = $restore(this, {in$1, out, variadic});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (!(variadic)) { _v = false; $s = 3; continue s; }
		if (in$1.$length === 0) { _v$1 = true; $s = 4; continue s; }
		_r = (x = in$1.$length - 1 >> 0, ((x < 0 || x >= in$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : in$1.$array[in$1.$offset + x])).Kind(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_v$1 = !((_r === 23)); case 4:
		_v = _v$1; case 3:
		/* */ if (_v) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_v) { */ case 1:
			$panic(new $String("reflect.FuncOf: last arg of variadic func must be slice"));
		/* } */ case 2:
		jsIn = $makeSlice(sliceType$8, in$1.$length);
		_ref = in$1;
		_i = 0;
		while (true) {
			if (!(_i < _ref.$length)) { break; }
			i = _i;
			v = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			((i < 0 || i >= jsIn.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsIn.$array[jsIn.$offset + i] = jsType(v));
			_i++;
		}
		jsOut = $makeSlice(sliceType$8, out.$length);
		_ref$1 = out;
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			i$1 = _i$1;
			v$1 = ((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]);
			((i$1 < 0 || i$1 >= jsOut.$length) ? ($throwRuntimeError("index out of range"), undefined) : jsOut.$array[jsOut.$offset + i$1] = jsType(v$1));
			_i$1++;
		}
		$s = -1; return reflectType($funcType($externalize(jsIn, sliceType$8), $externalize(jsOut, sliceType$8), $externalize(variadic, $Bool)));
		/* */ } return; } var $f = {$blk: FuncOf, $c: true, $r, _i, _i$1, _r, _ref, _ref$1, _v, _v$1, i, i$1, in$1, jsIn, jsOut, out, v, v$1, variadic, x, $s};return $f;
	};
	$pkg.FuncOf = FuncOf;
	rtype.ptr.prototype.ptrTo = function() {
		var t;
		t = this;
		return reflectType($ptrType(jsType(t)));
	};
	rtype.prototype.ptrTo = function() { return this.$val.ptrTo(); };
	SliceOf = function(t) {
		var t;
		return reflectType($sliceType(jsType(t)));
	};
	$pkg.SliceOf = SliceOf;
	unsafe_New = function(typ) {
		var _1, typ;
		_1 = typ.Kind();
		if (_1 === (25)) {
			return (new (jsType(typ).ptr)());
		} else if (_1 === (17)) {
			return (jsType(typ).zero());
		} else {
			return ($newDataPointer(jsType(typ).zero(), jsType(typ.ptrTo())));
		}
	};
	typedmemmove = function(t, dst, src) {
		var dst, src, t;
		dst.$set(src.$get());
	};
	keyFor = function(t, key) {
		var k, key, kv, t;
		kv = key;
		if (!(kv.$get === undefined)) {
			kv = kv.$get();
		}
		k = $internalize(jsType(t.Key()).keyFor(kv), $String);
		return [kv, k];
	};
	mapaccess = function(t, m, key) {
		var _tuple, entry, k, key, m, t;
		_tuple = keyFor(t, key);
		k = _tuple[1];
		entry = m.get($externalize(k, $String));
		if (entry === undefined) {
			return 0;
		}
		return ($newDataPointer(entry.v, jsType(PtrTo(t.Elem()))));
	};
	mapIter.ptr.prototype.skipUntilValidKey = function() {
		var iter, k;
		iter = this;
		while (true) {
			if (!(iter.i < $parseInt(iter.keys.length))) { break; }
			k = iter.keys[iter.i];
			if (!(iter.m.get(k) === undefined)) {
				break;
			}
			iter.i = iter.i + (1) >> 0;
		}
	};
	mapIter.prototype.skipUntilValidKey = function() { return this.$val.skipUntilValidKey(); };
	mapiterinit = function(t, m) {
		var m, t;
		return (new mapIter.ptr(t, m, $global.Array.from(m.keys()), 0, null));
	};
	mapiterkey = function(it) {
		var {$24r, _r, _r$1, _r$2, it, iter, k, kv, $s, $r, $c} = $restore(this, {it});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		iter = ($pointerOfStructConversion(it, ptrType$9));
		kv = null;
		if (!(iter.last === null)) {
			kv = iter.last;
		} else {
			iter.skipUntilValidKey();
			if (iter.i === $parseInt(iter.keys.length)) {
				$s = -1; return 0;
			}
			k = iter.keys[iter.i];
			kv = iter.m.get(k);
			iter.last = kv;
		}
		_r = $assertType(iter.t, TypeEx).Key(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = PtrTo(_r); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_r$2 = jsType(_r$1); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		$24r = ($newDataPointer(kv.k, _r$2));
		$s = 4; case 4: return $24r;
		/* */ } return; } var $f = {$blk: mapiterkey, $c: true, $r, $24r, _r, _r$1, _r$2, it, iter, k, kv, $s};return $f;
	};
	mapiternext = function(it) {
		var it, iter;
		iter = ($pointerOfStructConversion(it, ptrType$9));
		iter.last = null;
		iter.i = iter.i + (1) >> 0;
	};
	maplen = function(m) {
		var m;
		return $parseInt(m.size) >> 0;
	};
	methodReceiver = function(op, v, i) {
		var _, fn, i, m, m$1, ms, op, prop, rcvr, t, tt, v, x;
		_ = ptrType$1.nil;
		t = ptrType$5.nil;
		fn = 0;
		prop = "";
		if (v.typ.Kind() === 20) {
			tt = (v.typ.kindType);
			if (i < 0 || i >= tt.methods.$length) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m = (x = tt.methods, ((i < 0 || i >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + i]));
			if (!$clone(tt.rtype.nameOff(m.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (tt.rtype.typeOff(m.typ).kindType);
			prop = $clone(tt.rtype.nameOff(m.name), name).name();
		} else {
			ms = v.typ.exportedMethods();
			if (((i >>> 0)) >= ((ms.$length >>> 0))) {
				$panic(new $String("reflect: internal error: invalid method index"));
			}
			m$1 = $clone(((i < 0 || i >= ms.$length) ? ($throwRuntimeError("index out of range"), undefined) : ms.$array[ms.$offset + i]), method);
			if (!$clone(v.typ.nameOff(m$1.name), name).isExported()) {
				$panic(new $String("reflect: " + op + " of unexported method"));
			}
			t = (v.typ.typeOff(m$1.mtyp).kindType);
			prop = $internalize($methodSet(jsType(v.typ))[i].prop, $String);
		}
		rcvr = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr = new (jsType(v.typ))(rcvr);
		}
		fn = (rcvr[$externalize(prop, $String)]);
		return [_, t, fn];
	};
	valueInterface = function(v) {
		var {_r, cv, v, $s, $r, $c} = $restore(this, {v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		if (v.flag === 0) {
			$panic(new ValueError.ptr("reflect.Value.Interface", 0));
		}
		/* */ if (!((((v.flag & 512) >>> 0) === 0))) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (!((((v.flag & 512) >>> 0) === 0))) { */ case 1:
			_r = makeMethodValue("Interface", $clone(v, Value)); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			Value.copy(v, _r);
		/* } */ case 2:
		if (isWrapped(v.typ)) {
			if (!((((v.flag & 128) >>> 0) === 0)) && ($clone(v, Value).Kind() === 25)) {
				cv = jsType(v.typ).zero();
				copyStruct(cv, $clone(v, Value).object(), v.typ);
				$s = -1; return ((new (jsType(v.typ))(cv)));
			}
			$s = -1; return ((new (jsType(v.typ))($clone(v, Value).object())));
		}
		$s = -1; return (($clone(v, Value).object()));
		/* */ } return; } var $f = {$blk: valueInterface, $c: true, $r, _r, cv, v, $s};return $f;
	};
	ifaceE2I = function(t, src, dst) {
		var dst, src, t;
		dst.$set(src);
	};
	methodName = function() {
		return "?FIXME?";
	};
	makeMethodValue = function(op, v) {
		var {$24r, _r, _tuple, fn, fv, op, rcvr, v, $s, $r, $c} = $restore(this, {op, v});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		fn = [fn];
		rcvr = [rcvr];
		if (((v.flag & 512) >>> 0) === 0) {
			$panic(new $String("reflect: internal error: invalid use of makePartialFunc"));
		}
		_tuple = methodReceiver(op, $clone(v, Value), ((v.flag >> 0)) >> 10 >> 0);
		fn[0] = _tuple[2];
		rcvr[0] = $clone(v, Value).object();
		if (isWrapped(v.typ)) {
			rcvr[0] = new (jsType(v.typ))(rcvr[0]);
		}
		fv = js.MakeFunc((function(fn, rcvr) { return function(this$1, arguments$1) {
			var arguments$1, this$1;
			return new $jsObjectPtr(fn[0].apply(rcvr[0], $externalize(arguments$1, sliceType$8)));
		}; })(fn, rcvr));
		_r = $clone(v, Value).Type().common(); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = new Value.ptr(_r, (fv), (new flag(v.flag).ro() | 19) >>> 0);
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: makeMethodValue, $c: true, $r, $24r, _r, _tuple, fn, fv, op, rcvr, v, $s};return $f;
	};
	wrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return new (jsType(jsObjectPtr))(val);
		}
		return val;
	};
	unwrapJsObject = function(typ, val) {
		var typ, val;
		if ($interfaceIsEqual(typ, jsObjectPtr)) {
			return val.object;
		}
		return val;
	};
	getJsTag = function(tag) {
		var _tuple, i, name$1, qvalue, tag, value;
		while (true) {
			if (!(!(tag === ""))) { break; }
			i = 0;
			while (true) {
				if (!(i < tag.length && (tag.charCodeAt(i) === 32))) { break; }
				i = i + (1) >> 0;
			}
			tag = $substring(tag, i);
			if (tag === "") {
				break;
			}
			i = 0;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 32)) && !((tag.charCodeAt(i) === 58)) && !((tag.charCodeAt(i) === 34)))) { break; }
				i = i + (1) >> 0;
			}
			if ((i + 1 >> 0) >= tag.length || !((tag.charCodeAt(i) === 58)) || !((tag.charCodeAt((i + 1 >> 0)) === 34))) {
				break;
			}
			name$1 = ($substring(tag, 0, i));
			tag = $substring(tag, (i + 1 >> 0));
			i = 1;
			while (true) {
				if (!(i < tag.length && !((tag.charCodeAt(i) === 34)))) { break; }
				if (tag.charCodeAt(i) === 92) {
					i = i + (1) >> 0;
				}
				i = i + (1) >> 0;
			}
			if (i >= tag.length) {
				break;
			}
			qvalue = ($substring(tag, 0, (i + 1 >> 0)));
			tag = $substring(tag, (i + 1 >> 0));
			if (name$1 === "js") {
				_tuple = unquote(qvalue);
				value = _tuple[0];
				return value;
			}
		}
		return "";
	};
	PtrTo = function(t) {
		var t;
		return $assertType(t, ptrType$1).ptrTo();
	};
	$pkg.PtrTo = PtrTo;
	copyVal = function(typ, fl, ptr) {
		var c, fl, ptr, typ;
		if (ifaceIndir(typ)) {
			c = unsafe_New(typ);
			typedmemmove(typ, c, ptr);
			return new Value.ptr(typ, c, (fl | 128) >>> 0);
		}
		return new Value.ptr(typ, (ptr).$get(), fl);
	};
	Value.methods = [{prop: "pointer", name: "pointer", pkg: "internal/reflectlite", typ: $funcType([], [$UnsafePointer], false)}, {prop: "CanSet", name: "CanSet", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsValid", name: "IsValid", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "numMethod", name: "numMethod", pkg: "internal/reflectlite", typ: $funcType([], [$Int], false)}, {prop: "Type", name: "Type", pkg: "", typ: $funcType([], [Type], false)}, {prop: "object", name: "object", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$2], false)}, {prop: "assignTo", name: "assignTo", pkg: "internal/reflectlite", typ: $funcType([$String, ptrType$1, $UnsafePointer], [Value], false)}, {prop: "call", name: "call", pkg: "internal/reflectlite", typ: $funcType([$String, sliceType$6], [sliceType$6], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Index", name: "Index", pkg: "", typ: $funcType([$Int], [Value], false)}, {prop: "InterfaceData", name: "InterfaceData", pkg: "", typ: $funcType([], [arrayType$2], false)}, {prop: "IsNil", name: "IsNil", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Pointer", name: "Pointer", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Set", name: "Set", pkg: "", typ: $funcType([Value], [], false)}, {prop: "SetBytes", name: "SetBytes", pkg: "", typ: $funcType([sliceType$13], [], false)}, {prop: "SetCap", name: "SetCap", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "SetLen", name: "SetLen", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Slice", name: "Slice", pkg: "", typ: $funcType([$Int, $Int], [Value], false)}, {prop: "Slice3", name: "Slice3", pkg: "", typ: $funcType([$Int, $Int, $Int], [Value], false)}, {prop: "Close", name: "Close", pkg: "", typ: $funcType([], [], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Value], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "MapKeys", name: "MapKeys", pkg: "", typ: $funcType([], [sliceType$6], false)}, {prop: "MapIndex", name: "MapIndex", pkg: "", typ: $funcType([Value], [Value], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [Value], false)}];
	flag.methods = [{prop: "kind", name: "kind", pkg: "internal/reflectlite", typ: $funcType([], [Kind], false)}, {prop: "ro", name: "ro", pkg: "internal/reflectlite", typ: $funcType([], [flag], false)}, {prop: "mustBeExported", name: "mustBeExported", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBeAssignable", name: "mustBeAssignable", pkg: "internal/reflectlite", typ: $funcType([], [], false)}, {prop: "mustBe", name: "mustBe", pkg: "internal/reflectlite", typ: $funcType([Kind], [], false)}];
	ptrType$10.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	Kind.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$1.methods = [{prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "pointers", name: "pointers", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "hasName", name: "hasName", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "chanDir", name: "chanDir", pkg: "internal/reflectlite", typ: $funcType([], [chanDir], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "In", name: "In", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumIn", name: "NumIn", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "NumOut", name: "NumOut", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Out", name: "Out", pkg: "", typ: $funcType([$Int], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "IsVariadic", name: "IsVariadic", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "kindType", name: "kindType", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "Field", name: "Field", pkg: "", typ: $funcType([$Int], [structField], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "NumField", name: "NumField", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Method", name: "Method", pkg: "", typ: $funcType([$Int], [Method], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}, {prop: "nameOff", name: "nameOff", pkg: "internal/reflectlite", typ: $funcType([nameOff], [name], false)}, {prop: "typeOff", name: "typeOff", pkg: "internal/reflectlite", typ: $funcType([typeOff], [ptrType$1], false)}, {prop: "ptrTo", name: "ptrTo", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}];
	ptrType$11.methods = [{prop: "NumMethod", name: "NumMethod", pkg: "", typ: $funcType([], [$Int], false)}];
	ptrType$12.methods = [{prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$13.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	ptrType$4.methods = [{prop: "methods", name: "methods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}, {prop: "exportedMethods", name: "exportedMethods", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$5], false)}];
	ptrType$5.methods = [{prop: "in$", name: "in", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}, {prop: "out", name: "out", pkg: "internal/reflectlite", typ: $funcType([], [sliceType$2], false)}];
	name.methods = [{prop: "data", name: "data", pkg: "internal/reflectlite", typ: $funcType([$Int, $String], [ptrType$6], false)}, {prop: "hasTag", name: "hasTag", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "readVarint", name: "readVarint", pkg: "internal/reflectlite", typ: $funcType([$Int], [$Int, $Int], false)}, {prop: "name", name: "name", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "tag", name: "tag", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "pkgPath", name: "pkgPath", pkg: "internal/reflectlite", typ: $funcType([], [$String], false)}, {prop: "isExported", name: "isExported", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}, {prop: "embedded", name: "embedded", pkg: "internal/reflectlite", typ: $funcType([], [$Bool], false)}];
	ptrType$9.methods = [{prop: "skipUntilValidKey", name: "skipUntilValidKey", pkg: "internal/reflectlite", typ: $funcType([], [], false)}];
	Value.init("internal/reflectlite", [{prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "ptr", name: "ptr", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "flag", name: "flag", embedded: true, exported: false, typ: flag, tag: ""}]);
	ValueError.init("", [{prop: "Method", name: "Method", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Kind", name: "Kind", embedded: false, exported: true, typ: Kind, tag: ""}]);
	Type.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	rtype.init("internal/reflectlite", [{prop: "size", name: "size", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "ptrdata", name: "ptrdata", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "hash", name: "hash", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "tflag", name: "tflag", embedded: false, exported: false, typ: tflag, tag: ""}, {prop: "align", name: "align", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "fieldAlign", name: "fieldAlign", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "kind", name: "kind", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "equal", name: "equal", embedded: false, exported: false, typ: funcType$2, tag: ""}, {prop: "gcdata", name: "gcdata", embedded: false, exported: false, typ: ptrType$6, tag: ""}, {prop: "str", name: "str", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "ptrToThis", name: "ptrToThis", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	method.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mtyp", name: "mtyp", embedded: false, exported: false, typ: typeOff, tag: ""}, {prop: "ifn", name: "ifn", embedded: false, exported: false, typ: textOff, tag: ""}, {prop: "tfn", name: "tfn", embedded: false, exported: false, typ: textOff, tag: ""}]);
	arrayType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "slice", name: "slice", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "len", name: "len", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	chanType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "dir", name: "dir", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	imethod.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: typeOff, tag: ""}]);
	interfaceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "methods", name: "methods", embedded: false, exported: false, typ: sliceType$9, tag: ""}]);
	mapType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "key", name: "key", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "bucket", name: "bucket", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "hasher", name: "hasher", embedded: false, exported: false, typ: funcType$3, tag: ""}, {prop: "keysize", name: "keysize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "valuesize", name: "valuesize", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "bucketsize", name: "bucketsize", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "flags", name: "flags", embedded: false, exported: false, typ: $Uint32, tag: ""}]);
	ptrType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	sliceType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "elem", name: "elem", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	structField.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: name, tag: ""}, {prop: "typ", name: "typ", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "offset", name: "offset", embedded: false, exported: false, typ: $Uintptr, tag: ""}]);
	structType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: ""}, {prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: name, tag: ""}, {prop: "fields", name: "fields", embedded: false, exported: false, typ: sliceType$10, tag: ""}]);
	errorString.init("internal/reflectlite", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	Method.init("", [{prop: "Name", name: "Name", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "PkgPath", name: "PkgPath", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "Type", name: "Type", embedded: false, exported: true, typ: Type, tag: ""}, {prop: "Func", name: "Func", embedded: false, exported: true, typ: Value, tag: ""}, {prop: "Index", name: "Index", embedded: false, exported: true, typ: $Int, tag: ""}]);
	uncommonType.init("internal/reflectlite", [{prop: "pkgPath", name: "pkgPath", embedded: false, exported: false, typ: nameOff, tag: ""}, {prop: "mcount", name: "mcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "xcount", name: "xcount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "moff", name: "moff", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "_methods", name: "_methods", embedded: false, exported: false, typ: sliceType$5, tag: ""}]);
	funcType.init("internal/reflectlite", [{prop: "rtype", name: "rtype", embedded: true, exported: false, typ: rtype, tag: "reflect:\"func\""}, {prop: "inCount", name: "inCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "outCount", name: "outCount", embedded: false, exported: false, typ: $Uint16, tag: ""}, {prop: "_in", name: "_in", embedded: false, exported: false, typ: sliceType$2, tag: ""}, {prop: "_out", name: "_out", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	name.init("internal/reflectlite", [{prop: "bytes", name: "bytes", embedded: false, exported: false, typ: ptrType$6, tag: ""}]);
	nameData.init("internal/reflectlite", [{prop: "name", name: "name", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "tag", name: "tag", embedded: false, exported: false, typ: $String, tag: ""}, {prop: "exported", name: "exported", embedded: false, exported: false, typ: $Bool, tag: ""}, {prop: "embedded", name: "embedded", embedded: false, exported: false, typ: $Bool, tag: ""}]);
	mapIter.init("internal/reflectlite", [{prop: "t", name: "t", embedded: false, exported: false, typ: Type, tag: ""}, {prop: "m", name: "m", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "keys", name: "keys", embedded: false, exported: false, typ: ptrType$2, tag: ""}, {prop: "i", name: "i", embedded: false, exported: false, typ: $Int, tag: ""}, {prop: "last", name: "last", embedded: false, exported: false, typ: ptrType$2, tag: ""}]);
	TypeEx.init([{prop: "AssignableTo", name: "AssignableTo", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Comparable", name: "Comparable", pkg: "", typ: $funcType([], [$Bool], false)}, {prop: "Elem", name: "Elem", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Implements", name: "Implements", pkg: "", typ: $funcType([Type], [$Bool], false)}, {prop: "Key", name: "Key", pkg: "", typ: $funcType([], [Type], false)}, {prop: "Kind", name: "Kind", pkg: "", typ: $funcType([], [Kind], false)}, {prop: "Name", name: "Name", pkg: "", typ: $funcType([], [$String], false)}, {prop: "PkgPath", name: "PkgPath", pkg: "", typ: $funcType([], [$String], false)}, {prop: "Size", name: "Size", pkg: "", typ: $funcType([], [$Uintptr], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "common", name: "common", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$1], false)}, {prop: "uncommon", name: "uncommon", pkg: "internal/reflectlite", typ: $funcType([], [ptrType$4], false)}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = goarch.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		uint8Type = ptrType$1.nil;
		nameOffList = sliceType$1.nil;
		typeOffList = sliceType$2.nil;
		kindNames = new sliceType$3(["invalid", "bool", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "array", "chan", "func", "interface", "map", "ptr", "slice", "string", "struct", "unsafe.Pointer"]);
		callHelper = $assertType($internalize($call, $emptyInterface), funcType$1);
		$pkg.ErrSyntax = new errorString.ptr("invalid syntax");
		initialized = false;
		idJsType = "_jsType";
		idReflectType = "_reflectType";
		idKindType = "kindType";
		idRtype = "_rtype";
		uncommonTypeMap = new $global.Map();
		nameMap = new $global.Map();
		jsObjectPtr = reflectType($jsObjectPtr);
		selectHelper = $assertType($internalize($select, $emptyInterface), funcType$1);
		$r = init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["math/bits"] = (function() {
	var $pkg = {}, $init, Len, Len32, Len64;
	Len = function(x) {
		var x;
		if (true) {
			return Len32(((x >>> 0)));
		}
		return Len64((new $Uint64(0, x)));
	};
	$pkg.Len = Len;
	Len32 = function(x) {
		var n, x, y, y$1;
		n = 0;
		if (x >= 65536) {
			x = (y = (16), y < 32 ? (x >>> y) : 0) >>> 0;
			n = 16;
		}
		if (x >= 256) {
			x = (y$1 = (8), y$1 < 32 ? (x >>> y$1) : 0) >>> 0;
			n = n + (8) >> 0;
		}
		n = n + (("\x00\x01\x02\x02\x03\x03\x03\x03\x04\x04\x04\x04\x04\x04\x04\x04\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b".charCodeAt(x) >> 0)) >> 0;
		return n;
	};
	$pkg.Len32 = Len32;
	Len64 = function(x) {
		var n, x;
		n = 0;
		if ((x.$high > 1 || (x.$high === 1 && x.$low >= 0))) {
			x = $shiftRightUint64(x, (32));
			n = 32;
		}
		if ((x.$high > 0 || (x.$high === 0 && x.$low >= 65536))) {
			x = $shiftRightUint64(x, (16));
			n = n + (16) >> 0;
		}
		if ((x.$high > 0 || (x.$high === 0 && x.$low >= 256))) {
			x = $shiftRightUint64(x, (8));
			n = n + (8) >> 0;
		}
		n = n + (("\x00\x01\x02\x02\x03\x03\x03\x03\x04\x04\x04\x04\x04\x04\x04\x04\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x05\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x06\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\x07\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b\b".charCodeAt($flatten64(x)) >> 0)) >> 0;
		return n;
	};
	$pkg.Len64 = Len64;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sort"] = (function() {
	var $pkg = {}, $init, reflectlite, bits, xorshift, lessSwap, ptrType, ptrType$1, funcType, funcType$1, reflectValueOf, reflectSwapper, insertionSort_func, siftDown_func, heapSort_func, pdqsort_func, partition_func, partitionEqual_func, partialInsertionSort_func, breakPatterns_func, choosePivot_func, order2_func, median_func, medianAdjacent_func, reverseRange_func, nextPowerOfTwo, Slice;
	reflectlite = $packages["internal/reflectlite"];
	bits = $packages["math/bits"];
	xorshift = $pkg.xorshift = $newType(8, $kindUint64, "sort.xorshift", true, "sort", false, null);
	lessSwap = $pkg.lessSwap = $newType(0, $kindStruct, "sort.lessSwap", true, "sort", false, function(Less_, Swap_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Less = $throwNilPointerError;
			this.Swap = $throwNilPointerError;
			return;
		}
		this.Less = Less_;
		this.Swap = Swap_;
	});
	ptrType = $ptrType(xorshift);
	ptrType$1 = $ptrType($Int);
	funcType = $funcType([$Int, $Int], [$Bool], false);
	funcType$1 = $funcType([$Int, $Int], [], false);
	insertionSort_func = function(data, a, b) {
		var {_r, _v, a, b, data, i, j, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		i = a + 1 >> 0;
		/* while (true) { */ case 1:
			/* if (!(i < b)) { break; } */ if(!(i < b)) { $s = 2; continue; }
			j = i;
			/* while (true) { */ case 3:
				if (!(j > a)) { _v = false; $s = 5; continue s; }
				_r = data.Less(j, j - 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = _r; case 5:
				/* if (!(_v)) { break; } */ if(!(_v)) { $s = 4; continue; }
				$r = data.Swap(j, j - 1 >> 0); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				j = j - (1) >> 0;
			$s = 3; continue;
			case 4:
			i = i + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: insertionSort_func, $c: true, $r, _r, _v, a, b, data, i, j, $s};return $f;
	};
	siftDown_func = function(data, lo, hi, first) {
		var {_r, _r$1, _v, child, data, first, hi, lo, root, $s, $r, $c} = $restore(this, {data, lo, hi, first});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		root = lo;
		/* while (true) { */ case 1:
			child = ($imul(2, root)) + 1 >> 0;
			if (child >= hi) {
				/* break; */ $s = 2; continue;
			}
			if (!((child + 1 >> 0) < hi)) { _v = false; $s = 5; continue s; }
			_r = data.Less(first + child >> 0, (first + child >> 0) + 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_v = _r; case 5:
			/* */ if (_v) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_v) { */ case 3:
				child = child + (1) >> 0;
			/* } */ case 4:
			_r$1 = data.Less(first + root >> 0, first + child >> 0); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			/* */ if (!_r$1) { $s = 7; continue; }
			/* */ $s = 8; continue;
			/* if (!_r$1) { */ case 7:
				$s = -1; return;
			/* } */ case 8:
			$r = data.Swap(first + root >> 0, first + child >> 0); /* */ $s = 10; case 10: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			root = child;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: siftDown_func, $c: true, $r, _r, _r$1, _v, child, data, first, hi, lo, root, $s};return $f;
	};
	heapSort_func = function(data, a, b) {
		var {_q, a, b, data, first, hi, i, i$1, lo, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		first = a;
		lo = 0;
		hi = b - a >> 0;
		i = (_q = ((hi - 1 >> 0)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"));
		/* while (true) { */ case 1:
			/* if (!(i >= 0)) { break; } */ if(!(i >= 0)) { $s = 2; continue; }
			$r = siftDown_func($clone(data, lessSwap), i, hi, first); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i - (1) >> 0;
		$s = 1; continue;
		case 2:
		i$1 = hi - 1 >> 0;
		/* while (true) { */ case 4:
			/* if (!(i$1 >= 0)) { break; } */ if(!(i$1 >= 0)) { $s = 5; continue; }
			$r = data.Swap(first, first + i$1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$r = siftDown_func($clone(data, lessSwap), lo, i$1, first); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i$1 = i$1 - (1) >> 0;
		$s = 4; continue;
		case 5:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: heapSort_func, $c: true, $r, _q, a, b, data, first, hi, i, i$1, lo, $s};return $f;
	};
	pdqsort_func = function(data, a, b, limit) {
		var {_q, _r, _r$1, _r$2, _r$3, _r$4, _tmp, _tmp$1, _tuple, _tuple$1, _v, a, alreadyPartitioned, b, balanceThreshold, data, hint, leftLen, length, limit, mid, mid$1, pivot, rightLen, wasBalanced, wasPartitioned, $s, $r, $c} = $restore(this, {data, a, b, limit});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		wasBalanced = true;
		wasPartitioned = true;
		/* while (true) { */ case 1:
			length = b - a >> 0;
			/* */ if (length <= 12) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (length <= 12) { */ case 3:
				$r = insertionSort_func($clone(data, lessSwap), a, b); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return;
			/* } */ case 4:
			/* */ if (limit === 0) { $s = 6; continue; }
			/* */ $s = 7; continue;
			/* if (limit === 0) { */ case 6:
				$r = heapSort_func($clone(data, lessSwap), a, b); /* */ $s = 8; case 8: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				$s = -1; return;
			/* } */ case 7:
			/* */ if (!wasBalanced) { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (!wasBalanced) { */ case 9:
				$r = breakPatterns_func($clone(data, lessSwap), a, b); /* */ $s = 11; case 11: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				limit = limit - (1) >> 0;
			/* } */ case 10:
			_r = choosePivot_func($clone(data, lessSwap), a, b); /* */ $s = 12; case 12: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_tuple = _r;
			pivot = _tuple[0];
			hint = _tuple[1];
			/* */ if (hint === 2) { $s = 13; continue; }
			/* */ $s = 14; continue;
			/* if (hint === 2) { */ case 13:
				$r = reverseRange_func($clone(data, lessSwap), a, b); /* */ $s = 15; case 15: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				pivot = ((b - 1 >> 0)) - ((pivot - a >> 0)) >> 0;
				hint = 1;
			/* } */ case 14:
			/* */ if (wasBalanced && wasPartitioned && (hint === 1)) { $s = 16; continue; }
			/* */ $s = 17; continue;
			/* if (wasBalanced && wasPartitioned && (hint === 1)) { */ case 16:
				_r$1 = partialInsertionSort_func($clone(data, lessSwap), a, b); /* */ $s = 20; case 20: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				/* */ if (_r$1) { $s = 18; continue; }
				/* */ $s = 19; continue;
				/* if (_r$1) { */ case 18:
					$s = -1; return;
				/* } */ case 19:
			/* } */ case 17:
			if (!(a > 0)) { _v = false; $s = 23; continue s; }
			_r$2 = data.Less(a - 1 >> 0, pivot); /* */ $s = 24; case 24: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			_v = !_r$2; case 23:
			/* */ if (_v) { $s = 21; continue; }
			/* */ $s = 22; continue;
			/* if (_v) { */ case 21:
				_r$3 = partitionEqual_func($clone(data, lessSwap), a, b, pivot); /* */ $s = 25; case 25: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				mid = _r$3;
				a = mid;
				/* continue; */ $s = 1; continue;
			/* } */ case 22:
			_r$4 = partition_func($clone(data, lessSwap), a, b, pivot); /* */ $s = 26; case 26: if($c) { $c = false; _r$4 = _r$4.$blk(); } if (_r$4 && _r$4.$blk !== undefined) { break s; }
			_tuple$1 = _r$4;
			mid$1 = _tuple$1[0];
			alreadyPartitioned = _tuple$1[1];
			wasPartitioned = alreadyPartitioned;
			_tmp = mid$1 - a >> 0;
			_tmp$1 = b - mid$1 >> 0;
			leftLen = _tmp;
			rightLen = _tmp$1;
			balanceThreshold = (_q = length / 8, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"));
			/* */ if (leftLen < rightLen) { $s = 27; continue; }
			/* */ $s = 28; continue;
			/* if (leftLen < rightLen) { */ case 27:
				wasBalanced = leftLen >= balanceThreshold;
				$r = pdqsort_func($clone(data, lessSwap), a, mid$1, limit); /* */ $s = 30; case 30: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				a = mid$1 + 1 >> 0;
				$s = 29; continue;
			/* } else { */ case 28:
				wasBalanced = rightLen >= balanceThreshold;
				$r = pdqsort_func($clone(data, lessSwap), mid$1 + 1 >> 0, b, limit); /* */ $s = 31; case 31: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				b = mid$1;
			/* } */ case 29:
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: pdqsort_func, $c: true, $r, _q, _r, _r$1, _r$2, _r$3, _r$4, _tmp, _tmp$1, _tuple, _tuple$1, _v, a, alreadyPartitioned, b, balanceThreshold, data, hint, leftLen, length, limit, mid, mid$1, pivot, rightLen, wasBalanced, wasPartitioned, $s};return $f;
	};
	partition_func = function(data, a, b, pivot) {
		var {_r, _r$1, _r$2, _r$3, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _v, _v$1, _v$2, _v$3, a, alreadyPartitioned, b, data, i, j, newpivot, pivot, $s, $r, $c} = $restore(this, {data, a, b, pivot});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		newpivot = 0;
		alreadyPartitioned = false;
		$r = data.Swap(a, pivot); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_tmp = a + 1 >> 0;
		_tmp$1 = b - 1 >> 0;
		i = _tmp;
		j = _tmp$1;
		/* while (true) { */ case 2:
			if (!(i <= j)) { _v = false; $s = 4; continue s; }
			_r = data.Less(i, a); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			_v = _r; case 4:
			/* if (!(_v)) { break; } */ if(!(_v)) { $s = 3; continue; }
			i = i + (1) >> 0;
		$s = 2; continue;
		case 3:
		/* while (true) { */ case 6:
			if (!(i <= j)) { _v$1 = false; $s = 8; continue s; }
			_r$1 = data.Less(j, a); /* */ $s = 9; case 9: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			_v$1 = !_r$1; case 8:
			/* if (!(_v$1)) { break; } */ if(!(_v$1)) { $s = 7; continue; }
			j = j - (1) >> 0;
		$s = 6; continue;
		case 7:
		/* */ if (i > j) { $s = 10; continue; }
		/* */ $s = 11; continue;
		/* if (i > j) { */ case 10:
			$r = data.Swap(j, a); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_tmp$2 = j;
			_tmp$3 = true;
			newpivot = _tmp$2;
			alreadyPartitioned = _tmp$3;
			$s = -1; return [newpivot, alreadyPartitioned];
		/* } */ case 11:
		$r = data.Swap(i, j); /* */ $s = 13; case 13: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		i = i + (1) >> 0;
		j = j - (1) >> 0;
		/* while (true) { */ case 14:
			/* while (true) { */ case 16:
				if (!(i <= j)) { _v$2 = false; $s = 18; continue s; }
				_r$2 = data.Less(i, a); /* */ $s = 19; case 19: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				_v$2 = _r$2; case 18:
				/* if (!(_v$2)) { break; } */ if(!(_v$2)) { $s = 17; continue; }
				i = i + (1) >> 0;
			$s = 16; continue;
			case 17:
			/* while (true) { */ case 20:
				if (!(i <= j)) { _v$3 = false; $s = 22; continue s; }
				_r$3 = data.Less(j, a); /* */ $s = 23; case 23: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
				_v$3 = !_r$3; case 22:
				/* if (!(_v$3)) { break; } */ if(!(_v$3)) { $s = 21; continue; }
				j = j - (1) >> 0;
			$s = 20; continue;
			case 21:
			if (i > j) {
				/* break; */ $s = 15; continue;
			}
			$r = data.Swap(i, j); /* */ $s = 24; case 24: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i + (1) >> 0;
			j = j - (1) >> 0;
		$s = 14; continue;
		case 15:
		$r = data.Swap(j, a); /* */ $s = 25; case 25: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_tmp$4 = j;
		_tmp$5 = false;
		newpivot = _tmp$4;
		alreadyPartitioned = _tmp$5;
		$s = -1; return [newpivot, alreadyPartitioned];
		/* */ } return; } var $f = {$blk: partition_func, $c: true, $r, _r, _r$1, _r$2, _r$3, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _v, _v$1, _v$2, _v$3, a, alreadyPartitioned, b, data, i, j, newpivot, pivot, $s};return $f;
	};
	partitionEqual_func = function(data, a, b, pivot) {
		var {_r, _r$1, _tmp, _tmp$1, _v, _v$1, a, b, data, i, j, newpivot, pivot, $s, $r, $c} = $restore(this, {data, a, b, pivot});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		newpivot = 0;
		$r = data.Swap(a, pivot); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_tmp = a + 1 >> 0;
		_tmp$1 = b - 1 >> 0;
		i = _tmp;
		j = _tmp$1;
		/* while (true) { */ case 2:
			/* while (true) { */ case 4:
				if (!(i <= j)) { _v = false; $s = 6; continue s; }
				_r = data.Less(a, i); /* */ $s = 7; case 7: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = !_r; case 6:
				/* if (!(_v)) { break; } */ if(!(_v)) { $s = 5; continue; }
				i = i + (1) >> 0;
			$s = 4; continue;
			case 5:
			/* while (true) { */ case 8:
				if (!(i <= j)) { _v$1 = false; $s = 10; continue s; }
				_r$1 = data.Less(a, j); /* */ $s = 11; case 11: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				_v$1 = _r$1; case 10:
				/* if (!(_v$1)) { break; } */ if(!(_v$1)) { $s = 9; continue; }
				j = j - (1) >> 0;
			$s = 8; continue;
			case 9:
			if (i > j) {
				/* break; */ $s = 3; continue;
			}
			$r = data.Swap(i, j); /* */ $s = 12; case 12: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i + (1) >> 0;
			j = j - (1) >> 0;
		$s = 2; continue;
		case 3:
		newpivot = i;
		$s = -1; return newpivot;
		/* */ } return; } var $f = {$blk: partitionEqual_func, $c: true, $r, _r, _r$1, _tmp, _tmp$1, _v, _v$1, a, b, data, i, j, newpivot, pivot, $s};return $f;
	};
	partialInsertionSort_func = function(data, a, b) {
		var {_r, _r$1, _r$2, _v, a, b, data, i, j, j$1, j$2, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		i = a + 1 >> 0;
		j = 0;
		/* while (true) { */ case 1:
			/* if (!(j < 5)) { break; } */ if(!(j < 5)) { $s = 2; continue; }
			/* while (true) { */ case 3:
				if (!(i < b)) { _v = false; $s = 5; continue s; }
				_r = data.Less(i, i - 1 >> 0); /* */ $s = 6; case 6: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				_v = !_r; case 5:
				/* if (!(_v)) { break; } */ if(!(_v)) { $s = 4; continue; }
				i = i + (1) >> 0;
			$s = 3; continue;
			case 4:
			if (i === b) {
				$s = -1; return true;
			}
			if ((b - a >> 0) < 50) {
				$s = -1; return false;
			}
			$r = data.Swap(i, i - 1 >> 0); /* */ $s = 7; case 7: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			/* */ if ((i - a >> 0) >= 2) { $s = 8; continue; }
			/* */ $s = 9; continue;
			/* if ((i - a >> 0) >= 2) { */ case 8:
				j$1 = i - 1 >> 0;
				/* while (true) { */ case 10:
					/* if (!(j$1 >= 1)) { break; } */ if(!(j$1 >= 1)) { $s = 11; continue; }
					_r$1 = data.Less(j$1, j$1 - 1 >> 0); /* */ $s = 14; case 14: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
					/* */ if (!_r$1) { $s = 12; continue; }
					/* */ $s = 13; continue;
					/* if (!_r$1) { */ case 12:
						/* break; */ $s = 11; continue;
					/* } */ case 13:
					$r = data.Swap(j$1, j$1 - 1 >> 0); /* */ $s = 15; case 15: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					j$1 = j$1 - (1) >> 0;
				$s = 10; continue;
				case 11:
			/* } */ case 9:
			/* */ if ((b - i >> 0) >= 2) { $s = 16; continue; }
			/* */ $s = 17; continue;
			/* if ((b - i >> 0) >= 2) { */ case 16:
				j$2 = i + 1 >> 0;
				/* while (true) { */ case 18:
					/* if (!(j$2 < b)) { break; } */ if(!(j$2 < b)) { $s = 19; continue; }
					_r$2 = data.Less(j$2, j$2 - 1 >> 0); /* */ $s = 22; case 22: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
					/* */ if (!_r$2) { $s = 20; continue; }
					/* */ $s = 21; continue;
					/* if (!_r$2) { */ case 20:
						/* break; */ $s = 19; continue;
					/* } */ case 21:
					$r = data.Swap(j$2, j$2 - 1 >> 0); /* */ $s = 23; case 23: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
					j$2 = j$2 + (1) >> 0;
				$s = 18; continue;
				case 19:
			/* } */ case 17:
			j = j + (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return false;
		/* */ } return; } var $f = {$blk: partialInsertionSort_func, $c: true, $r, _r, _r$1, _r$2, _v, a, b, data, i, j, j$1, j$2, $s};return $f;
	};
	breakPatterns_func = function(data, a, b) {
		var {_q, _q$1, a, b, data, idx, length, modulus, other, random, random$24ptr, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		length = b - a >> 0;
		/* */ if (length >= 8) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (length >= 8) { */ case 1:
			random = (new xorshift(0, length));
			modulus = nextPowerOfTwo(length);
			idx = (a + ($imul(((_q = length / 4, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero"))), 2)) >> 0) - 1 >> 0;
			/* while (true) { */ case 3:
				/* if (!(idx <= ((a + ($imul(((_q$1 = length / 4, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero"))), 2)) >> 0) + 1 >> 0))) { break; } */ if(!(idx <= ((a + ($imul(((_q$1 = length / 4, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero"))), 2)) >> 0) + 1 >> 0))) { $s = 4; continue; }
				other = (((((((random$24ptr || (random$24ptr = new ptrType(function() { return random; }, function($v) { random = $v; }))).Next().$low >>> 0)) & ((modulus - 1 >>> 0))) >>> 0) >> 0));
				if (other >= length) {
					other = other - (length) >> 0;
				}
				$r = data.Swap(idx, a + other >> 0); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
				idx = idx + (1) >> 0;
			$s = 3; continue;
			case 4:
		/* } */ case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: breakPatterns_func, $c: true, $r, _q, _q$1, a, b, data, idx, length, modulus, other, random, random$24ptr, $s};return $f;
	};
	choosePivot_func = function(data, a, b) {
		var {_1, _q, _q$1, _q$2, _r, _r$1, _r$2, _r$3, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, a, b, data, hint, i, j, k, l, pivot, swaps, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		swaps = [swaps];
		pivot = 0;
		hint = 0;
		l = b - a >> 0;
		swaps[0] = 0;
		i = a + ($imul((_q = l / 4, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")), 1)) >> 0;
		j = a + ($imul((_q$1 = l / 4, (_q$1 === _q$1 && _q$1 !== 1/0 && _q$1 !== -1/0) ? _q$1 >> 0 : $throwRuntimeError("integer divide by zero")), 2)) >> 0;
		k = a + ($imul((_q$2 = l / 4, (_q$2 === _q$2 && _q$2 !== 1/0 && _q$2 !== -1/0) ? _q$2 >> 0 : $throwRuntimeError("integer divide by zero")), 3)) >> 0;
		/* */ if (l >= 8) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (l >= 8) { */ case 1:
			/* */ if (l >= 50) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (l >= 50) { */ case 3:
				_r = medianAdjacent_func($clone(data, lessSwap), i, (swaps.$ptr || (swaps.$ptr = new ptrType$1(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, swaps)))); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				i = _r;
				_r$1 = medianAdjacent_func($clone(data, lessSwap), j, (swaps.$ptr || (swaps.$ptr = new ptrType$1(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, swaps)))); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				j = _r$1;
				_r$2 = medianAdjacent_func($clone(data, lessSwap), k, (swaps.$ptr || (swaps.$ptr = new ptrType$1(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, swaps)))); /* */ $s = 7; case 7: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
				k = _r$2;
			/* } */ case 4:
			_r$3 = median_func($clone(data, lessSwap), i, j, k, (swaps.$ptr || (swaps.$ptr = new ptrType$1(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, swaps)))); /* */ $s = 8; case 8: if($c) { $c = false; _r$3 = _r$3.$blk(); } if (_r$3 && _r$3.$blk !== undefined) { break s; }
			j = _r$3;
		/* } */ case 2:
		_1 = swaps[0];
		if (_1 === (0)) {
			_tmp = j;
			_tmp$1 = 1;
			pivot = _tmp;
			hint = _tmp$1;
			$s = -1; return [pivot, hint];
		} else if (_1 === (12)) {
			_tmp$2 = j;
			_tmp$3 = 2;
			pivot = _tmp$2;
			hint = _tmp$3;
			$s = -1; return [pivot, hint];
		} else {
			_tmp$4 = j;
			_tmp$5 = 0;
			pivot = _tmp$4;
			hint = _tmp$5;
			$s = -1; return [pivot, hint];
		}
		$s = -1; return [pivot, hint];
		/* */ } return; } var $f = {$blk: choosePivot_func, $c: true, $r, _1, _q, _q$1, _q$2, _r, _r$1, _r$2, _r$3, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, a, b, data, hint, i, j, k, l, pivot, swaps, $s};return $f;
	};
	order2_func = function(data, a, b, swaps) {
		var {_r, a, b, data, swaps, $s, $r, $c} = $restore(this, {data, a, b, swaps});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = data.Less(b, a); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		/* */ if (_r) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (_r) { */ case 1:
			swaps.$set(swaps.$get() + (1) >> 0);
			$s = -1; return [b, a];
		/* } */ case 2:
		$s = -1; return [a, b];
		/* */ } return; } var $f = {$blk: order2_func, $c: true, $r, _r, a, b, data, swaps, $s};return $f;
	};
	median_func = function(data, a, b, c, swaps) {
		var {_r, _r$1, _r$2, _tuple, _tuple$1, _tuple$2, a, b, c, data, swaps, $s, $r, $c} = $restore(this, {data, a, b, c, swaps});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = order2_func($clone(data, lessSwap), a, b, swaps); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_tuple = _r;
		a = _tuple[0];
		b = _tuple[1];
		_r$1 = order2_func($clone(data, lessSwap), b, c, swaps); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		_tuple$1 = _r$1;
		b = _tuple$1[0];
		c = _tuple$1[1];
		_r$2 = order2_func($clone(data, lessSwap), a, b, swaps); /* */ $s = 3; case 3: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
		_tuple$2 = _r$2;
		a = _tuple$2[0];
		b = _tuple$2[1];
		$s = -1; return b;
		/* */ } return; } var $f = {$blk: median_func, $c: true, $r, _r, _r$1, _r$2, _tuple, _tuple$1, _tuple$2, a, b, c, data, swaps, $s};return $f;
	};
	medianAdjacent_func = function(data, a, swaps) {
		var {$24r, _r, a, data, swaps, $s, $r, $c} = $restore(this, {data, a, swaps});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = median_func($clone(data, lessSwap), a - 1 >> 0, a, a + 1 >> 0, swaps); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: medianAdjacent_func, $c: true, $r, $24r, _r, a, data, swaps, $s};return $f;
	};
	reverseRange_func = function(data, a, b) {
		var {a, b, data, i, j, $s, $r, $c} = $restore(this, {data, a, b});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		i = a;
		j = b - 1 >> 0;
		/* while (true) { */ case 1:
			/* if (!(i < j)) { break; } */ if(!(i < j)) { $s = 2; continue; }
			$r = data.Swap(i, j); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i + (1) >> 0;
			j = j - (1) >> 0;
		$s = 1; continue;
		case 2:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: reverseRange_func, $c: true, $r, a, b, data, i, j, $s};return $f;
	};
	$ptrType(xorshift).prototype.Next = function() {
		var r, x, x$1, x$2, x$3, x$4, x$5, x$6;
		r = this;
		r.$set((x = r.$get(), x$1 = $shiftLeft64(r.$get(), 13), new xorshift(x.$high ^ x$1.$high, (x.$low ^ x$1.$low) >>> 0)));
		r.$set((x$2 = r.$get(), x$3 = $shiftRightUint64(r.$get(), 17), new xorshift(x$2.$high ^ x$3.$high, (x$2.$low ^ x$3.$low) >>> 0)));
		r.$set((x$4 = r.$get(), x$5 = $shiftLeft64(r.$get(), 5), new xorshift(x$4.$high ^ x$5.$high, (x$4.$low ^ x$5.$low) >>> 0)));
		return ((x$6 = r.$get(), new $Uint64(x$6.$high, x$6.$low)));
	};
	nextPowerOfTwo = function(length) {
		var length, shift, y;
		shift = ((bits.Len(((length >>> 0))) >>> 0));
		return (((y = shift, y < 32 ? (1 << y) : 0) >>> 0));
	};
	Slice = function(x, less) {
		var {_r, _r$1, length, less, limit, rv, swap, x, $s, $r, $c} = $restore(this, {x, less});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = reflectValueOf(x); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		rv = $clone(_r, reflectlite.Value);
		_r$1 = reflectSwapper(x); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		swap = _r$1;
		length = $clone(rv, reflectlite.Value).Len();
		limit = bits.Len(((length >>> 0)));
		$r = pdqsort_func($clone(new lessSwap.ptr(less, swap), lessSwap), 0, length, limit); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Slice, $c: true, $r, _r, _r$1, length, less, limit, rv, swap, x, $s};return $f;
	};
	$pkg.Slice = Slice;
	ptrType.methods = [{prop: "Next", name: "Next", pkg: "", typ: $funcType([], [$Uint64], false)}];
	lessSwap.init("", [{prop: "Less", name: "Less", embedded: false, exported: true, typ: funcType, tag: ""}, {prop: "Swap", name: "Swap", embedded: false, exported: true, typ: funcType$1, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflectlite.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = bits.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		reflectValueOf = reflectlite.ValueOf;
		reflectSwapper = reflectlite.Swapper;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["errors"] = (function() {
	var $pkg = {}, $init, reflectlite, errorString, ptrType, ptrType$1, errorType, _r, New;
	reflectlite = $packages["internal/reflectlite"];
	errorString = $pkg.errorString = $newType(0, $kindStruct, "errors.errorString", true, "errors", false, function(s_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.s = "";
			return;
		}
		this.s = s_;
	});
	ptrType = $ptrType($error);
	ptrType$1 = $ptrType(errorString);
	New = function(text) {
		var text;
		return new errorString.ptr(text);
	};
	$pkg.New = New;
	errorString.ptr.prototype.Error = function() {
		var e;
		e = this;
		return e.s;
	};
	errorString.prototype.Error = function() { return this.$val.Error(); };
	ptrType$1.methods = [{prop: "Error", name: "Error", pkg: "", typ: $funcType([], [$String], false)}];
	errorString.init("errors", [{prop: "s", name: "s", embedded: false, exported: false, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = reflectlite.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_r = reflectlite.TypeOf((ptrType.nil)).Elem(); /* */ $s = 2; case 2: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		errorType = _r;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["internal/race"] = (function() {
	var $pkg = {}, $init;
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sync/atomic"] = (function() {
	var $pkg = {}, $init, js;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["sync"] = (function() {
	var $pkg = {}, $init, js, race, atomic, notifyList, Pool, sliceType$3, ptrType$20, funcType$2, expunged, semWaiters, semAwoken, init, runtime_notifyListCheck;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	race = $packages["internal/race"];
	atomic = $packages["sync/atomic"];
	notifyList = $pkg.notifyList = $newType(0, $kindStruct, "sync.notifyList", true, "sync", false, function(wait_, notify_, lock_, head_, tail_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.wait = 0;
			this.notify = 0;
			this.lock = 0;
			this.head = 0;
			this.tail = 0;
			return;
		}
		this.wait = wait_;
		this.notify = notify_;
		this.lock = lock_;
		this.head = head_;
		this.tail = tail_;
	});
	Pool = $pkg.Pool = $newType(0, $kindStruct, "sync.Pool", true, "sync", true, function(store_, New_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.store = sliceType$3.nil;
			this.New = $throwNilPointerError;
			return;
		}
		this.store = store_;
		this.New = New_;
	});
	sliceType$3 = $sliceType($emptyInterface);
	ptrType$20 = $ptrType(Pool);
	funcType$2 = $funcType([], [$emptyInterface], false);
	init = function() {
		var n;
		n = new notifyList.ptr(0, 0, 0, 0, 0);
		runtime_notifyListCheck(20);
	};
	runtime_notifyListCheck = function(size) {
		var size;
	};
	Pool.ptr.prototype.Get = function() {
		var {$24r, _r, p, x, x$1, x$2, $s, $r, $c} = $restore(this, {});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		p = this;
		/* */ if (p.store.$length === 0) { $s = 1; continue; }
		/* */ $s = 2; continue;
		/* if (p.store.$length === 0) { */ case 1:
			/* */ if (!(p.New === $throwNilPointerError)) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (!(p.New === $throwNilPointerError)) { */ case 3:
				_r = p.New(); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 6; case 6: return $24r;
			/* } */ case 4:
			$s = -1; return $ifaceNil;
		/* } */ case 2:
		x$2 = (x = p.store, x$1 = p.store.$length - 1 >> 0, ((x$1 < 0 || x$1 >= x.$length) ? ($throwRuntimeError("index out of range"), undefined) : x.$array[x.$offset + x$1]));
		p.store = $subslice(p.store, 0, (p.store.$length - 1 >> 0));
		$s = -1; return x$2;
		/* */ } return; } var $f = {$blk: Pool.ptr.prototype.Get, $c: true, $r, $24r, _r, p, x, x$1, x$2, $s};return $f;
	};
	Pool.prototype.Get = function() { return this.$val.Get(); };
	Pool.ptr.prototype.Put = function(x) {
		var p, x;
		p = this;
		if ($interfaceIsEqual(x, $ifaceNil)) {
			return;
		}
		p.store = $append(p.store, x);
	};
	Pool.prototype.Put = function(x) { return this.$val.Put(x); };
	ptrType$20.methods = [{prop: "Get", name: "Get", pkg: "", typ: $funcType([], [$emptyInterface], false)}, {prop: "Put", name: "Put", pkg: "", typ: $funcType([$emptyInterface], [], false)}];
	notifyList.init("sync", [{prop: "wait", name: "wait", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "notify", name: "notify", embedded: false, exported: false, typ: $Uint32, tag: ""}, {prop: "lock", name: "lock", embedded: false, exported: false, typ: $Uintptr, tag: ""}, {prop: "head", name: "head", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}, {prop: "tail", name: "tail", embedded: false, exported: false, typ: $UnsafePointer, tag: ""}]);
	Pool.init("sync", [{prop: "store", name: "store", embedded: false, exported: false, typ: sliceType$3, tag: ""}, {prop: "New", name: "New", embedded: false, exported: true, typ: funcType$2, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = race.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = atomic.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		expunged = (new Uint8Array(8));
		semWaiters = new $global.Map();
		semAwoken = new $global.Map();
		init();
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["io"] = (function() {
	var $pkg = {}, $init, errors, sync, sliceType, sliceType$1, ptrType$2, errInvalidWrite, errWhence, errOffset, blackHolePool;
	errors = $packages["errors"];
	sync = $packages["sync"];
	sliceType = $sliceType($emptyInterface);
	sliceType$1 = $sliceType($Uint8);
	ptrType$2 = $ptrType(sliceType$1);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = errors.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sync.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$pkg.ErrClosedPipe = errors.New("io: read/write on closed pipe");
		$pkg.ErrShortWrite = errors.New("short write");
		errInvalidWrite = errors.New("invalid write result");
		$pkg.ErrShortBuffer = errors.New("short buffer");
		$pkg.EOF = errors.New("EOF");
		$pkg.ErrUnexpectedEOF = errors.New("unexpected EOF");
		$pkg.ErrNoProgress = errors.New("multiple Read calls return no data or error");
		errWhence = errors.New("Seek: invalid whence");
		errOffset = errors.New("Seek: invalid offset");
		blackHolePool = new sync.Pool.ptr(sliceType.nil, (function() {
			var b, b$24ptr;
			b = $makeSlice(sliceType$1, 8192);
			return (b$24ptr || (b$24ptr = new ptrType$2(function() { return b; }, function($v) { b = $v; })));
		}));
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["unicode"] = (function() {
	var $pkg = {}, $init, RangeTable, Range16, Range32, CaseRange, d, sliceType, sliceType$1, sliceType$3, arrayType, _White_Space, _CaseRanges, is16, is32, isExcludingLatin, To, ToLower, IsSpace, to;
	RangeTable = $pkg.RangeTable = $newType(0, $kindStruct, "unicode.RangeTable", true, "unicode", true, function(R16_, R32_, LatinOffset_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.R16 = sliceType.nil;
			this.R32 = sliceType$1.nil;
			this.LatinOffset = 0;
			return;
		}
		this.R16 = R16_;
		this.R32 = R32_;
		this.LatinOffset = LatinOffset_;
	});
	Range16 = $pkg.Range16 = $newType(0, $kindStruct, "unicode.Range16", true, "unicode", true, function(Lo_, Hi_, Stride_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Lo = 0;
			this.Hi = 0;
			this.Stride = 0;
			return;
		}
		this.Lo = Lo_;
		this.Hi = Hi_;
		this.Stride = Stride_;
	});
	Range32 = $pkg.Range32 = $newType(0, $kindStruct, "unicode.Range32", true, "unicode", true, function(Lo_, Hi_, Stride_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Lo = 0;
			this.Hi = 0;
			this.Stride = 0;
			return;
		}
		this.Lo = Lo_;
		this.Hi = Hi_;
		this.Stride = Stride_;
	});
	CaseRange = $pkg.CaseRange = $newType(0, $kindStruct, "unicode.CaseRange", true, "unicode", true, function(Lo_, Hi_, Delta_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Lo = 0;
			this.Hi = 0;
			this.Delta = arrayType.zero();
			return;
		}
		this.Lo = Lo_;
		this.Hi = Hi_;
		this.Delta = Delta_;
	});
	d = $pkg.d = $newType(12, $kindArray, "unicode.d", true, "unicode", false, null);
	sliceType = $sliceType(Range16);
	sliceType$1 = $sliceType(Range32);
	sliceType$3 = $sliceType(CaseRange);
	arrayType = $arrayType($Int32, 3);
	is16 = function(ranges, r) {
		var _i, _q, _r, _r$1, _ref, hi, i, lo, m, r, range_, range_$1, ranges;
		if (ranges.$length <= 18 || r <= 255) {
			_ref = ranges;
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				i = _i;
				range_ = ((i < 0 || i >= ranges.$length) ? ($throwRuntimeError("index out of range"), undefined) : ranges.$array[ranges.$offset + i]);
				if (r < range_.Lo) {
					return false;
				}
				if (r <= range_.Hi) {
					return (range_.Stride === 1) || ((_r = ((r - range_.Lo << 16 >>> 16)) % range_.Stride, _r === _r ? _r : $throwRuntimeError("integer divide by zero")) === 0);
				}
				_i++;
			}
			return false;
		}
		lo = 0;
		hi = ranges.$length;
		while (true) {
			if (!(lo < hi)) { break; }
			m = lo + (_q = ((hi - lo >> 0)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")) >> 0;
			range_$1 = ((m < 0 || m >= ranges.$length) ? ($throwRuntimeError("index out of range"), undefined) : ranges.$array[ranges.$offset + m]);
			if (range_$1.Lo <= r && r <= range_$1.Hi) {
				return (range_$1.Stride === 1) || ((_r$1 = ((r - range_$1.Lo << 16 >>> 16)) % range_$1.Stride, _r$1 === _r$1 ? _r$1 : $throwRuntimeError("integer divide by zero")) === 0);
			}
			if (r < range_$1.Lo) {
				hi = m;
			} else {
				lo = m + 1 >> 0;
			}
		}
		return false;
	};
	is32 = function(ranges, r) {
		var _i, _q, _r, _r$1, _ref, hi, i, lo, m, r, range_, range_$1, ranges;
		if (ranges.$length <= 18) {
			_ref = ranges;
			_i = 0;
			while (true) {
				if (!(_i < _ref.$length)) { break; }
				i = _i;
				range_ = ((i < 0 || i >= ranges.$length) ? ($throwRuntimeError("index out of range"), undefined) : ranges.$array[ranges.$offset + i]);
				if (r < range_.Lo) {
					return false;
				}
				if (r <= range_.Hi) {
					return (range_.Stride === 1) || ((_r = ((r - range_.Lo >>> 0)) % range_.Stride, _r === _r ? _r : $throwRuntimeError("integer divide by zero")) === 0);
				}
				_i++;
			}
			return false;
		}
		lo = 0;
		hi = ranges.$length;
		while (true) {
			if (!(lo < hi)) { break; }
			m = lo + (_q = ((hi - lo >> 0)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")) >> 0;
			range_$1 = $clone(((m < 0 || m >= ranges.$length) ? ($throwRuntimeError("index out of range"), undefined) : ranges.$array[ranges.$offset + m]), Range32);
			if (range_$1.Lo <= r && r <= range_$1.Hi) {
				return (range_$1.Stride === 1) || ((_r$1 = ((r - range_$1.Lo >>> 0)) % range_$1.Stride, _r$1 === _r$1 ? _r$1 : $throwRuntimeError("integer divide by zero")) === 0);
			}
			if (r < range_$1.Lo) {
				hi = m;
			} else {
				lo = m + 1 >> 0;
			}
		}
		return false;
	};
	isExcludingLatin = function(rangeTab, r) {
		var off, r, r16, r32, rangeTab, x;
		r16 = rangeTab.R16;
		off = rangeTab.LatinOffset;
		if (r16.$length > off && ((r >>> 0)) <= (((x = r16.$length - 1 >> 0, ((x < 0 || x >= r16.$length) ? ($throwRuntimeError("index out of range"), undefined) : r16.$array[r16.$offset + x])).Hi >>> 0))) {
			return is16($subslice(r16, off), ((r << 16 >>> 16)));
		}
		r32 = rangeTab.R32;
		if (r32.$length > 0 && r >= (((0 >= r32.$length ? ($throwRuntimeError("index out of range"), undefined) : r32.$array[r32.$offset + 0]).Lo >> 0))) {
			return is32(r32, ((r >>> 0)));
		}
		return false;
	};
	To = function(_case, r) {
		var _case, _tuple, r;
		_tuple = to(_case, r, $pkg.CaseRanges);
		r = _tuple[0];
		return r;
	};
	$pkg.To = To;
	ToLower = function(r) {
		var r;
		if (r <= 127) {
			if (65 <= r && r <= 90) {
				r = r + (32) >> 0;
			}
			return r;
		}
		return To(1, r);
	};
	$pkg.ToLower = ToLower;
	IsSpace = function(r) {
		var _1, r;
		if (((r >>> 0)) <= 255) {
			_1 = r;
			if ((_1 === (9)) || (_1 === (10)) || (_1 === (11)) || (_1 === (12)) || (_1 === (13)) || (_1 === (32)) || (_1 === (133)) || (_1 === (160))) {
				return true;
			}
			return false;
		}
		return isExcludingLatin($pkg.White_Space, r);
	};
	$pkg.IsSpace = IsSpace;
	to = function(_case, r, caseRange) {
		var _case, _q, _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, caseRange, cr, delta, foundMapping, hi, lo, m, mappedRune, r, x;
		mappedRune = 0;
		foundMapping = false;
		if (_case < 0 || 3 <= _case) {
			_tmp = 65533;
			_tmp$1 = false;
			mappedRune = _tmp;
			foundMapping = _tmp$1;
			return [mappedRune, foundMapping];
		}
		lo = 0;
		hi = caseRange.$length;
		while (true) {
			if (!(lo < hi)) { break; }
			m = lo + (_q = ((hi - lo >> 0)) / 2, (_q === _q && _q !== 1/0 && _q !== -1/0) ? _q >> 0 : $throwRuntimeError("integer divide by zero")) >> 0;
			cr = ((m < 0 || m >= caseRange.$length) ? ($throwRuntimeError("index out of range"), undefined) : caseRange.$array[caseRange.$offset + m]);
			if (((cr.Lo >> 0)) <= r && r <= ((cr.Hi >> 0))) {
				delta = ((x = cr.Delta, ((_case < 0 || _case >= x.length) ? ($throwRuntimeError("index out of range"), undefined) : x[_case])));
				if (delta > 1114111) {
					_tmp$2 = ((cr.Lo >> 0)) + ((((((r - ((cr.Lo >> 0)) >> 0)) & ~1) >> 0) | (((_case & 1) >> 0)))) >> 0;
					_tmp$3 = true;
					mappedRune = _tmp$2;
					foundMapping = _tmp$3;
					return [mappedRune, foundMapping];
				}
				_tmp$4 = r + delta >> 0;
				_tmp$5 = true;
				mappedRune = _tmp$4;
				foundMapping = _tmp$5;
				return [mappedRune, foundMapping];
			}
			if (r < ((cr.Lo >> 0))) {
				hi = m;
			} else {
				lo = m + 1 >> 0;
			}
		}
		_tmp$6 = r;
		_tmp$7 = false;
		mappedRune = _tmp$6;
		foundMapping = _tmp$7;
		return [mappedRune, foundMapping];
	};
	RangeTable.init("", [{prop: "R16", name: "R16", embedded: false, exported: true, typ: sliceType, tag: ""}, {prop: "R32", name: "R32", embedded: false, exported: true, typ: sliceType$1, tag: ""}, {prop: "LatinOffset", name: "LatinOffset", embedded: false, exported: true, typ: $Int, tag: ""}]);
	Range16.init("", [{prop: "Lo", name: "Lo", embedded: false, exported: true, typ: $Uint16, tag: ""}, {prop: "Hi", name: "Hi", embedded: false, exported: true, typ: $Uint16, tag: ""}, {prop: "Stride", name: "Stride", embedded: false, exported: true, typ: $Uint16, tag: ""}]);
	Range32.init("", [{prop: "Lo", name: "Lo", embedded: false, exported: true, typ: $Uint32, tag: ""}, {prop: "Hi", name: "Hi", embedded: false, exported: true, typ: $Uint32, tag: ""}, {prop: "Stride", name: "Stride", embedded: false, exported: true, typ: $Uint32, tag: ""}]);
	CaseRange.init("", [{prop: "Lo", name: "Lo", embedded: false, exported: true, typ: $Uint32, tag: ""}, {prop: "Hi", name: "Hi", embedded: false, exported: true, typ: $Uint32, tag: ""}, {prop: "Delta", name: "Delta", embedded: false, exported: true, typ: d, tag: ""}]);
	d.init($Int32, 3);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		_White_Space = new RangeTable.ptr(new sliceType([$clone(new Range16.ptr(9, 13, 1), Range16), $clone(new Range16.ptr(32, 133, 101), Range16), $clone(new Range16.ptr(160, 5760, 5600), Range16), $clone(new Range16.ptr(8192, 8202, 1), Range16), $clone(new Range16.ptr(8232, 8233, 1), Range16), $clone(new Range16.ptr(8239, 8287, 48), Range16), $clone(new Range16.ptr(12288, 12288, 1), Range16)]), sliceType$1.nil, 2);
		$pkg.White_Space = _White_Space;
		_CaseRanges = new sliceType$3([$clone(new CaseRange.ptr(65, 90, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(97, 122, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(181, 181, $clone($toNativeArray($kindInt32, [743, 0, 743]), d)), CaseRange), $clone(new CaseRange.ptr(192, 214, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(216, 222, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(224, 246, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(248, 254, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(255, 255, $clone($toNativeArray($kindInt32, [121, 0, 121]), d)), CaseRange), $clone(new CaseRange.ptr(256, 303, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(304, 304, $clone($toNativeArray($kindInt32, [0, -199, 0]), d)), CaseRange), $clone(new CaseRange.ptr(305, 305, $clone($toNativeArray($kindInt32, [-232, 0, -232]), d)), CaseRange), $clone(new CaseRange.ptr(306, 311, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(313, 328, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(330, 375, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(376, 376, $clone($toNativeArray($kindInt32, [0, -121, 0]), d)), CaseRange), $clone(new CaseRange.ptr(377, 382, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(383, 383, $clone($toNativeArray($kindInt32, [-300, 0, -300]), d)), CaseRange), $clone(new CaseRange.ptr(384, 384, $clone($toNativeArray($kindInt32, [195, 0, 195]), d)), CaseRange), $clone(new CaseRange.ptr(385, 385, $clone($toNativeArray($kindInt32, [0, 210, 0]), d)), CaseRange), $clone(new CaseRange.ptr(386, 389, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(390, 390, $clone($toNativeArray($kindInt32, [0, 206, 0]), d)), CaseRange), $clone(new CaseRange.ptr(391, 392, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(393, 394, $clone($toNativeArray($kindInt32, [0, 205, 0]), d)), CaseRange), $clone(new CaseRange.ptr(395, 396, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(398, 398, $clone($toNativeArray($kindInt32, [0, 79, 0]), d)), CaseRange), $clone(new CaseRange.ptr(399, 399, $clone($toNativeArray($kindInt32, [0, 202, 0]), d)), CaseRange), $clone(new CaseRange.ptr(400, 400, $clone($toNativeArray($kindInt32, [0, 203, 0]), d)), CaseRange), $clone(new CaseRange.ptr(401, 402, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(403, 403, $clone($toNativeArray($kindInt32, [0, 205, 0]), d)), CaseRange), $clone(new CaseRange.ptr(404, 404, $clone($toNativeArray($kindInt32, [0, 207, 0]), d)), CaseRange), $clone(new CaseRange.ptr(405, 405, $clone($toNativeArray($kindInt32, [97, 0, 97]), d)), CaseRange), $clone(new CaseRange.ptr(406, 406, $clone($toNativeArray($kindInt32, [0, 211, 0]), d)), CaseRange), $clone(new CaseRange.ptr(407, 407, $clone($toNativeArray($kindInt32, [0, 209, 0]), d)), CaseRange), $clone(new CaseRange.ptr(408, 409, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(410, 410, $clone($toNativeArray($kindInt32, [163, 0, 163]), d)), CaseRange), $clone(new CaseRange.ptr(412, 412, $clone($toNativeArray($kindInt32, [0, 211, 0]), d)), CaseRange), $clone(new CaseRange.ptr(413, 413, $clone($toNativeArray($kindInt32, [0, 213, 0]), d)), CaseRange), $clone(new CaseRange.ptr(414, 414, $clone($toNativeArray($kindInt32, [130, 0, 130]), d)), CaseRange), $clone(new CaseRange.ptr(415, 415, $clone($toNativeArray($kindInt32, [0, 214, 0]), d)), CaseRange), $clone(new CaseRange.ptr(416, 421, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(422, 422, $clone($toNativeArray($kindInt32, [0, 218, 0]), d)), CaseRange), $clone(new CaseRange.ptr(423, 424, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(425, 425, $clone($toNativeArray($kindInt32, [0, 218, 0]), d)), CaseRange), $clone(new CaseRange.ptr(428, 429, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(430, 430, $clone($toNativeArray($kindInt32, [0, 218, 0]), d)), CaseRange), $clone(new CaseRange.ptr(431, 432, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(433, 434, $clone($toNativeArray($kindInt32, [0, 217, 0]), d)), CaseRange), $clone(new CaseRange.ptr(435, 438, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(439, 439, $clone($toNativeArray($kindInt32, [0, 219, 0]), d)), CaseRange), $clone(new CaseRange.ptr(440, 441, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(444, 445, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(447, 447, $clone($toNativeArray($kindInt32, [56, 0, 56]), d)), CaseRange), $clone(new CaseRange.ptr(452, 452, $clone($toNativeArray($kindInt32, [0, 2, 1]), d)), CaseRange), $clone(new CaseRange.ptr(453, 453, $clone($toNativeArray($kindInt32, [-1, 1, 0]), d)), CaseRange), $clone(new CaseRange.ptr(454, 454, $clone($toNativeArray($kindInt32, [-2, 0, -1]), d)), CaseRange), $clone(new CaseRange.ptr(455, 455, $clone($toNativeArray($kindInt32, [0, 2, 1]), d)), CaseRange), $clone(new CaseRange.ptr(456, 456, $clone($toNativeArray($kindInt32, [-1, 1, 0]), d)), CaseRange), $clone(new CaseRange.ptr(457, 457, $clone($toNativeArray($kindInt32, [-2, 0, -1]), d)), CaseRange), $clone(new CaseRange.ptr(458, 458, $clone($toNativeArray($kindInt32, [0, 2, 1]), d)), CaseRange), $clone(new CaseRange.ptr(459, 459, $clone($toNativeArray($kindInt32, [-1, 1, 0]), d)), CaseRange), $clone(new CaseRange.ptr(460, 460, $clone($toNativeArray($kindInt32, [-2, 0, -1]), d)), CaseRange), $clone(new CaseRange.ptr(461, 476, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(477, 477, $clone($toNativeArray($kindInt32, [-79, 0, -79]), d)), CaseRange), $clone(new CaseRange.ptr(478, 495, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(497, 497, $clone($toNativeArray($kindInt32, [0, 2, 1]), d)), CaseRange), $clone(new CaseRange.ptr(498, 498, $clone($toNativeArray($kindInt32, [-1, 1, 0]), d)), CaseRange), $clone(new CaseRange.ptr(499, 499, $clone($toNativeArray($kindInt32, [-2, 0, -1]), d)), CaseRange), $clone(new CaseRange.ptr(500, 501, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(502, 502, $clone($toNativeArray($kindInt32, [0, -97, 0]), d)), CaseRange), $clone(new CaseRange.ptr(503, 503, $clone($toNativeArray($kindInt32, [0, -56, 0]), d)), CaseRange), $clone(new CaseRange.ptr(504, 543, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(544, 544, $clone($toNativeArray($kindInt32, [0, -130, 0]), d)), CaseRange), $clone(new CaseRange.ptr(546, 563, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(570, 570, $clone($toNativeArray($kindInt32, [0, 10795, 0]), d)), CaseRange), $clone(new CaseRange.ptr(571, 572, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(573, 573, $clone($toNativeArray($kindInt32, [0, -163, 0]), d)), CaseRange), $clone(new CaseRange.ptr(574, 574, $clone($toNativeArray($kindInt32, [0, 10792, 0]), d)), CaseRange), $clone(new CaseRange.ptr(575, 576, $clone($toNativeArray($kindInt32, [10815, 0, 10815]), d)), CaseRange), $clone(new CaseRange.ptr(577, 578, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(579, 579, $clone($toNativeArray($kindInt32, [0, -195, 0]), d)), CaseRange), $clone(new CaseRange.ptr(580, 580, $clone($toNativeArray($kindInt32, [0, 69, 0]), d)), CaseRange), $clone(new CaseRange.ptr(581, 581, $clone($toNativeArray($kindInt32, [0, 71, 0]), d)), CaseRange), $clone(new CaseRange.ptr(582, 591, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(592, 592, $clone($toNativeArray($kindInt32, [10783, 0, 10783]), d)), CaseRange), $clone(new CaseRange.ptr(593, 593, $clone($toNativeArray($kindInt32, [10780, 0, 10780]), d)), CaseRange), $clone(new CaseRange.ptr(594, 594, $clone($toNativeArray($kindInt32, [10782, 0, 10782]), d)), CaseRange), $clone(new CaseRange.ptr(595, 595, $clone($toNativeArray($kindInt32, [-210, 0, -210]), d)), CaseRange), $clone(new CaseRange.ptr(596, 596, $clone($toNativeArray($kindInt32, [-206, 0, -206]), d)), CaseRange), $clone(new CaseRange.ptr(598, 599, $clone($toNativeArray($kindInt32, [-205, 0, -205]), d)), CaseRange), $clone(new CaseRange.ptr(601, 601, $clone($toNativeArray($kindInt32, [-202, 0, -202]), d)), CaseRange), $clone(new CaseRange.ptr(603, 603, $clone($toNativeArray($kindInt32, [-203, 0, -203]), d)), CaseRange), $clone(new CaseRange.ptr(604, 604, $clone($toNativeArray($kindInt32, [42319, 0, 42319]), d)), CaseRange), $clone(new CaseRange.ptr(608, 608, $clone($toNativeArray($kindInt32, [-205, 0, -205]), d)), CaseRange), $clone(new CaseRange.ptr(609, 609, $clone($toNativeArray($kindInt32, [42315, 0, 42315]), d)), CaseRange), $clone(new CaseRange.ptr(611, 611, $clone($toNativeArray($kindInt32, [-207, 0, -207]), d)), CaseRange), $clone(new CaseRange.ptr(613, 613, $clone($toNativeArray($kindInt32, [42280, 0, 42280]), d)), CaseRange), $clone(new CaseRange.ptr(614, 614, $clone($toNativeArray($kindInt32, [42308, 0, 42308]), d)), CaseRange), $clone(new CaseRange.ptr(616, 616, $clone($toNativeArray($kindInt32, [-209, 0, -209]), d)), CaseRange), $clone(new CaseRange.ptr(617, 617, $clone($toNativeArray($kindInt32, [-211, 0, -211]), d)), CaseRange), $clone(new CaseRange.ptr(618, 618, $clone($toNativeArray($kindInt32, [42308, 0, 42308]), d)), CaseRange), $clone(new CaseRange.ptr(619, 619, $clone($toNativeArray($kindInt32, [10743, 0, 10743]), d)), CaseRange), $clone(new CaseRange.ptr(620, 620, $clone($toNativeArray($kindInt32, [42305, 0, 42305]), d)), CaseRange), $clone(new CaseRange.ptr(623, 623, $clone($toNativeArray($kindInt32, [-211, 0, -211]), d)), CaseRange), $clone(new CaseRange.ptr(625, 625, $clone($toNativeArray($kindInt32, [10749, 0, 10749]), d)), CaseRange), $clone(new CaseRange.ptr(626, 626, $clone($toNativeArray($kindInt32, [-213, 0, -213]), d)), CaseRange), $clone(new CaseRange.ptr(629, 629, $clone($toNativeArray($kindInt32, [-214, 0, -214]), d)), CaseRange), $clone(new CaseRange.ptr(637, 637, $clone($toNativeArray($kindInt32, [10727, 0, 10727]), d)), CaseRange), $clone(new CaseRange.ptr(640, 640, $clone($toNativeArray($kindInt32, [-218, 0, -218]), d)), CaseRange), $clone(new CaseRange.ptr(642, 642, $clone($toNativeArray($kindInt32, [42307, 0, 42307]), d)), CaseRange), $clone(new CaseRange.ptr(643, 643, $clone($toNativeArray($kindInt32, [-218, 0, -218]), d)), CaseRange), $clone(new CaseRange.ptr(647, 647, $clone($toNativeArray($kindInt32, [42282, 0, 42282]), d)), CaseRange), $clone(new CaseRange.ptr(648, 648, $clone($toNativeArray($kindInt32, [-218, 0, -218]), d)), CaseRange), $clone(new CaseRange.ptr(649, 649, $clone($toNativeArray($kindInt32, [-69, 0, -69]), d)), CaseRange), $clone(new CaseRange.ptr(650, 651, $clone($toNativeArray($kindInt32, [-217, 0, -217]), d)), CaseRange), $clone(new CaseRange.ptr(652, 652, $clone($toNativeArray($kindInt32, [-71, 0, -71]), d)), CaseRange), $clone(new CaseRange.ptr(658, 658, $clone($toNativeArray($kindInt32, [-219, 0, -219]), d)), CaseRange), $clone(new CaseRange.ptr(669, 669, $clone($toNativeArray($kindInt32, [42261, 0, 42261]), d)), CaseRange), $clone(new CaseRange.ptr(670, 670, $clone($toNativeArray($kindInt32, [42258, 0, 42258]), d)), CaseRange), $clone(new CaseRange.ptr(837, 837, $clone($toNativeArray($kindInt32, [84, 0, 84]), d)), CaseRange), $clone(new CaseRange.ptr(880, 883, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(886, 887, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(891, 893, $clone($toNativeArray($kindInt32, [130, 0, 130]), d)), CaseRange), $clone(new CaseRange.ptr(895, 895, $clone($toNativeArray($kindInt32, [0, 116, 0]), d)), CaseRange), $clone(new CaseRange.ptr(902, 902, $clone($toNativeArray($kindInt32, [0, 38, 0]), d)), CaseRange), $clone(new CaseRange.ptr(904, 906, $clone($toNativeArray($kindInt32, [0, 37, 0]), d)), CaseRange), $clone(new CaseRange.ptr(908, 908, $clone($toNativeArray($kindInt32, [0, 64, 0]), d)), CaseRange), $clone(new CaseRange.ptr(910, 911, $clone($toNativeArray($kindInt32, [0, 63, 0]), d)), CaseRange), $clone(new CaseRange.ptr(913, 929, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(931, 939, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(940, 940, $clone($toNativeArray($kindInt32, [-38, 0, -38]), d)), CaseRange), $clone(new CaseRange.ptr(941, 943, $clone($toNativeArray($kindInt32, [-37, 0, -37]), d)), CaseRange), $clone(new CaseRange.ptr(945, 961, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(962, 962, $clone($toNativeArray($kindInt32, [-31, 0, -31]), d)), CaseRange), $clone(new CaseRange.ptr(963, 971, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(972, 972, $clone($toNativeArray($kindInt32, [-64, 0, -64]), d)), CaseRange), $clone(new CaseRange.ptr(973, 974, $clone($toNativeArray($kindInt32, [-63, 0, -63]), d)), CaseRange), $clone(new CaseRange.ptr(975, 975, $clone($toNativeArray($kindInt32, [0, 8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(976, 976, $clone($toNativeArray($kindInt32, [-62, 0, -62]), d)), CaseRange), $clone(new CaseRange.ptr(977, 977, $clone($toNativeArray($kindInt32, [-57, 0, -57]), d)), CaseRange), $clone(new CaseRange.ptr(981, 981, $clone($toNativeArray($kindInt32, [-47, 0, -47]), d)), CaseRange), $clone(new CaseRange.ptr(982, 982, $clone($toNativeArray($kindInt32, [-54, 0, -54]), d)), CaseRange), $clone(new CaseRange.ptr(983, 983, $clone($toNativeArray($kindInt32, [-8, 0, -8]), d)), CaseRange), $clone(new CaseRange.ptr(984, 1007, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1008, 1008, $clone($toNativeArray($kindInt32, [-86, 0, -86]), d)), CaseRange), $clone(new CaseRange.ptr(1009, 1009, $clone($toNativeArray($kindInt32, [-80, 0, -80]), d)), CaseRange), $clone(new CaseRange.ptr(1010, 1010, $clone($toNativeArray($kindInt32, [7, 0, 7]), d)), CaseRange), $clone(new CaseRange.ptr(1011, 1011, $clone($toNativeArray($kindInt32, [-116, 0, -116]), d)), CaseRange), $clone(new CaseRange.ptr(1012, 1012, $clone($toNativeArray($kindInt32, [0, -60, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1013, 1013, $clone($toNativeArray($kindInt32, [-96, 0, -96]), d)), CaseRange), $clone(new CaseRange.ptr(1015, 1016, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1017, 1017, $clone($toNativeArray($kindInt32, [0, -7, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1018, 1019, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1021, 1023, $clone($toNativeArray($kindInt32, [0, -130, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1024, 1039, $clone($toNativeArray($kindInt32, [0, 80, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1040, 1071, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1072, 1103, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(1104, 1119, $clone($toNativeArray($kindInt32, [-80, 0, -80]), d)), CaseRange), $clone(new CaseRange.ptr(1120, 1153, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1162, 1215, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1216, 1216, $clone($toNativeArray($kindInt32, [0, 15, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1217, 1230, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1231, 1231, $clone($toNativeArray($kindInt32, [-15, 0, -15]), d)), CaseRange), $clone(new CaseRange.ptr(1232, 1327, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(1329, 1366, $clone($toNativeArray($kindInt32, [0, 48, 0]), d)), CaseRange), $clone(new CaseRange.ptr(1377, 1414, $clone($toNativeArray($kindInt32, [-48, 0, -48]), d)), CaseRange), $clone(new CaseRange.ptr(4256, 4293, $clone($toNativeArray($kindInt32, [0, 7264, 0]), d)), CaseRange), $clone(new CaseRange.ptr(4295, 4295, $clone($toNativeArray($kindInt32, [0, 7264, 0]), d)), CaseRange), $clone(new CaseRange.ptr(4301, 4301, $clone($toNativeArray($kindInt32, [0, 7264, 0]), d)), CaseRange), $clone(new CaseRange.ptr(4304, 4346, $clone($toNativeArray($kindInt32, [3008, 0, 0]), d)), CaseRange), $clone(new CaseRange.ptr(4349, 4351, $clone($toNativeArray($kindInt32, [3008, 0, 0]), d)), CaseRange), $clone(new CaseRange.ptr(5024, 5103, $clone($toNativeArray($kindInt32, [0, 38864, 0]), d)), CaseRange), $clone(new CaseRange.ptr(5104, 5109, $clone($toNativeArray($kindInt32, [0, 8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(5112, 5117, $clone($toNativeArray($kindInt32, [-8, 0, -8]), d)), CaseRange), $clone(new CaseRange.ptr(7296, 7296, $clone($toNativeArray($kindInt32, [-6254, 0, -6254]), d)), CaseRange), $clone(new CaseRange.ptr(7297, 7297, $clone($toNativeArray($kindInt32, [-6253, 0, -6253]), d)), CaseRange), $clone(new CaseRange.ptr(7298, 7298, $clone($toNativeArray($kindInt32, [-6244, 0, -6244]), d)), CaseRange), $clone(new CaseRange.ptr(7299, 7300, $clone($toNativeArray($kindInt32, [-6242, 0, -6242]), d)), CaseRange), $clone(new CaseRange.ptr(7301, 7301, $clone($toNativeArray($kindInt32, [-6243, 0, -6243]), d)), CaseRange), $clone(new CaseRange.ptr(7302, 7302, $clone($toNativeArray($kindInt32, [-6236, 0, -6236]), d)), CaseRange), $clone(new CaseRange.ptr(7303, 7303, $clone($toNativeArray($kindInt32, [-6181, 0, -6181]), d)), CaseRange), $clone(new CaseRange.ptr(7304, 7304, $clone($toNativeArray($kindInt32, [35266, 0, 35266]), d)), CaseRange), $clone(new CaseRange.ptr(7312, 7354, $clone($toNativeArray($kindInt32, [0, -3008, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7357, 7359, $clone($toNativeArray($kindInt32, [0, -3008, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7545, 7545, $clone($toNativeArray($kindInt32, [35332, 0, 35332]), d)), CaseRange), $clone(new CaseRange.ptr(7549, 7549, $clone($toNativeArray($kindInt32, [3814, 0, 3814]), d)), CaseRange), $clone(new CaseRange.ptr(7566, 7566, $clone($toNativeArray($kindInt32, [35384, 0, 35384]), d)), CaseRange), $clone(new CaseRange.ptr(7680, 7829, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(7835, 7835, $clone($toNativeArray($kindInt32, [-59, 0, -59]), d)), CaseRange), $clone(new CaseRange.ptr(7838, 7838, $clone($toNativeArray($kindInt32, [0, -7615, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7840, 7935, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(7936, 7943, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(7944, 7951, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7952, 7957, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(7960, 7965, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7968, 7975, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(7976, 7983, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(7984, 7991, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(7992, 7999, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8000, 8005, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8008, 8013, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8017, 8017, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8019, 8019, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8021, 8021, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8023, 8023, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8025, 8025, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8027, 8027, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8029, 8029, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8031, 8031, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8032, 8039, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8040, 8047, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8048, 8049, $clone($toNativeArray($kindInt32, [74, 0, 74]), d)), CaseRange), $clone(new CaseRange.ptr(8050, 8053, $clone($toNativeArray($kindInt32, [86, 0, 86]), d)), CaseRange), $clone(new CaseRange.ptr(8054, 8055, $clone($toNativeArray($kindInt32, [100, 0, 100]), d)), CaseRange), $clone(new CaseRange.ptr(8056, 8057, $clone($toNativeArray($kindInt32, [128, 0, 128]), d)), CaseRange), $clone(new CaseRange.ptr(8058, 8059, $clone($toNativeArray($kindInt32, [112, 0, 112]), d)), CaseRange), $clone(new CaseRange.ptr(8060, 8061, $clone($toNativeArray($kindInt32, [126, 0, 126]), d)), CaseRange), $clone(new CaseRange.ptr(8064, 8071, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8072, 8079, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8080, 8087, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8088, 8095, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8096, 8103, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8104, 8111, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8112, 8113, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8115, 8115, $clone($toNativeArray($kindInt32, [9, 0, 9]), d)), CaseRange), $clone(new CaseRange.ptr(8120, 8121, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8122, 8123, $clone($toNativeArray($kindInt32, [0, -74, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8124, 8124, $clone($toNativeArray($kindInt32, [0, -9, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8126, 8126, $clone($toNativeArray($kindInt32, [-7205, 0, -7205]), d)), CaseRange), $clone(new CaseRange.ptr(8131, 8131, $clone($toNativeArray($kindInt32, [9, 0, 9]), d)), CaseRange), $clone(new CaseRange.ptr(8136, 8139, $clone($toNativeArray($kindInt32, [0, -86, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8140, 8140, $clone($toNativeArray($kindInt32, [0, -9, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8144, 8145, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8152, 8153, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8154, 8155, $clone($toNativeArray($kindInt32, [0, -100, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8160, 8161, $clone($toNativeArray($kindInt32, [8, 0, 8]), d)), CaseRange), $clone(new CaseRange.ptr(8165, 8165, $clone($toNativeArray($kindInt32, [7, 0, 7]), d)), CaseRange), $clone(new CaseRange.ptr(8168, 8169, $clone($toNativeArray($kindInt32, [0, -8, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8170, 8171, $clone($toNativeArray($kindInt32, [0, -112, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8172, 8172, $clone($toNativeArray($kindInt32, [0, -7, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8179, 8179, $clone($toNativeArray($kindInt32, [9, 0, 9]), d)), CaseRange), $clone(new CaseRange.ptr(8184, 8185, $clone($toNativeArray($kindInt32, [0, -128, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8186, 8187, $clone($toNativeArray($kindInt32, [0, -126, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8188, 8188, $clone($toNativeArray($kindInt32, [0, -9, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8486, 8486, $clone($toNativeArray($kindInt32, [0, -7517, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8490, 8490, $clone($toNativeArray($kindInt32, [0, -8383, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8491, 8491, $clone($toNativeArray($kindInt32, [0, -8262, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8498, 8498, $clone($toNativeArray($kindInt32, [0, 28, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8526, 8526, $clone($toNativeArray($kindInt32, [-28, 0, -28]), d)), CaseRange), $clone(new CaseRange.ptr(8544, 8559, $clone($toNativeArray($kindInt32, [0, 16, 0]), d)), CaseRange), $clone(new CaseRange.ptr(8560, 8575, $clone($toNativeArray($kindInt32, [-16, 0, -16]), d)), CaseRange), $clone(new CaseRange.ptr(8579, 8580, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(9398, 9423, $clone($toNativeArray($kindInt32, [0, 26, 0]), d)), CaseRange), $clone(new CaseRange.ptr(9424, 9449, $clone($toNativeArray($kindInt32, [-26, 0, -26]), d)), CaseRange), $clone(new CaseRange.ptr(11264, 11310, $clone($toNativeArray($kindInt32, [0, 48, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11312, 11358, $clone($toNativeArray($kindInt32, [-48, 0, -48]), d)), CaseRange), $clone(new CaseRange.ptr(11360, 11361, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11362, 11362, $clone($toNativeArray($kindInt32, [0, -10743, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11363, 11363, $clone($toNativeArray($kindInt32, [0, -3814, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11364, 11364, $clone($toNativeArray($kindInt32, [0, -10727, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11365, 11365, $clone($toNativeArray($kindInt32, [-10795, 0, -10795]), d)), CaseRange), $clone(new CaseRange.ptr(11366, 11366, $clone($toNativeArray($kindInt32, [-10792, 0, -10792]), d)), CaseRange), $clone(new CaseRange.ptr(11367, 11372, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11373, 11373, $clone($toNativeArray($kindInt32, [0, -10780, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11374, 11374, $clone($toNativeArray($kindInt32, [0, -10749, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11375, 11375, $clone($toNativeArray($kindInt32, [0, -10783, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11376, 11376, $clone($toNativeArray($kindInt32, [0, -10782, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11378, 11379, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11381, 11382, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11390, 11391, $clone($toNativeArray($kindInt32, [0, -10815, 0]), d)), CaseRange), $clone(new CaseRange.ptr(11392, 11491, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11499, 11502, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11506, 11507, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(11520, 11557, $clone($toNativeArray($kindInt32, [-7264, 0, -7264]), d)), CaseRange), $clone(new CaseRange.ptr(11559, 11559, $clone($toNativeArray($kindInt32, [-7264, 0, -7264]), d)), CaseRange), $clone(new CaseRange.ptr(11565, 11565, $clone($toNativeArray($kindInt32, [-7264, 0, -7264]), d)), CaseRange), $clone(new CaseRange.ptr(42560, 42605, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42624, 42651, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42786, 42799, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42802, 42863, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42873, 42876, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42877, 42877, $clone($toNativeArray($kindInt32, [0, -35332, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42878, 42887, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42891, 42892, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42893, 42893, $clone($toNativeArray($kindInt32, [0, -42280, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42896, 42899, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42900, 42900, $clone($toNativeArray($kindInt32, [48, 0, 48]), d)), CaseRange), $clone(new CaseRange.ptr(42902, 42921, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42922, 42922, $clone($toNativeArray($kindInt32, [0, -42308, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42923, 42923, $clone($toNativeArray($kindInt32, [0, -42319, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42924, 42924, $clone($toNativeArray($kindInt32, [0, -42315, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42925, 42925, $clone($toNativeArray($kindInt32, [0, -42305, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42926, 42926, $clone($toNativeArray($kindInt32, [0, -42308, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42928, 42928, $clone($toNativeArray($kindInt32, [0, -42258, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42929, 42929, $clone($toNativeArray($kindInt32, [0, -42282, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42930, 42930, $clone($toNativeArray($kindInt32, [0, -42261, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42931, 42931, $clone($toNativeArray($kindInt32, [0, 928, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42932, 42943, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42946, 42947, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42948, 42948, $clone($toNativeArray($kindInt32, [0, -48, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42949, 42949, $clone($toNativeArray($kindInt32, [0, -42307, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42950, 42950, $clone($toNativeArray($kindInt32, [0, -35384, 0]), d)), CaseRange), $clone(new CaseRange.ptr(42951, 42954, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(42997, 42998, $clone($toNativeArray($kindInt32, [1114112, 1114112, 1114112]), d)), CaseRange), $clone(new CaseRange.ptr(43859, 43859, $clone($toNativeArray($kindInt32, [-928, 0, -928]), d)), CaseRange), $clone(new CaseRange.ptr(43888, 43967, $clone($toNativeArray($kindInt32, [-38864, 0, -38864]), d)), CaseRange), $clone(new CaseRange.ptr(65313, 65338, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(65345, 65370, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(66560, 66599, $clone($toNativeArray($kindInt32, [0, 40, 0]), d)), CaseRange), $clone(new CaseRange.ptr(66600, 66639, $clone($toNativeArray($kindInt32, [-40, 0, -40]), d)), CaseRange), $clone(new CaseRange.ptr(66736, 66771, $clone($toNativeArray($kindInt32, [0, 40, 0]), d)), CaseRange), $clone(new CaseRange.ptr(66776, 66811, $clone($toNativeArray($kindInt32, [-40, 0, -40]), d)), CaseRange), $clone(new CaseRange.ptr(68736, 68786, $clone($toNativeArray($kindInt32, [0, 64, 0]), d)), CaseRange), $clone(new CaseRange.ptr(68800, 68850, $clone($toNativeArray($kindInt32, [-64, 0, -64]), d)), CaseRange), $clone(new CaseRange.ptr(71840, 71871, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(71872, 71903, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(93760, 93791, $clone($toNativeArray($kindInt32, [0, 32, 0]), d)), CaseRange), $clone(new CaseRange.ptr(93792, 93823, $clone($toNativeArray($kindInt32, [-32, 0, -32]), d)), CaseRange), $clone(new CaseRange.ptr(125184, 125217, $clone($toNativeArray($kindInt32, [0, 34, 0]), d)), CaseRange), $clone(new CaseRange.ptr(125218, 125251, $clone($toNativeArray($kindInt32, [-34, 0, -34]), d)), CaseRange)]);
		$pkg.CaseRanges = _CaseRanges;
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["unicode/utf8"] = (function() {
	var $pkg = {}, $init, acceptRange, first, acceptRanges, DecodeRuneInString, DecodeLastRuneInString, RuneLen, EncodeRune, RuneStart;
	acceptRange = $pkg.acceptRange = $newType(0, $kindStruct, "utf8.acceptRange", true, "unicode/utf8", false, function(lo_, hi_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.lo = 0;
			this.hi = 0;
			return;
		}
		this.lo = lo_;
		this.hi = hi_;
	});
	DecodeRuneInString = function(s) {
		var _tmp, _tmp$1, _tmp$10, _tmp$11, _tmp$12, _tmp$13, _tmp$14, _tmp$15, _tmp$16, _tmp$17, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tmp$8, _tmp$9, accept, mask, n, r, s, s0, s1, s2, s3, size, sz, x, x$1;
		r = 0;
		size = 0;
		n = s.length;
		if (n < 1) {
			_tmp = 65533;
			_tmp$1 = 0;
			r = _tmp;
			size = _tmp$1;
			return [r, size];
		}
		s0 = s.charCodeAt(0);
		x = ((s0 < 0 || s0 >= first.length) ? ($throwRuntimeError("index out of range"), undefined) : first[s0]);
		if (x >= 240) {
			mask = (((x >> 0)) << 31 >> 0) >> 31 >> 0;
			_tmp$2 = ((((s.charCodeAt(0) >> 0)) & ~mask) >> 0) | (65533 & mask);
			_tmp$3 = 1;
			r = _tmp$2;
			size = _tmp$3;
			return [r, size];
		}
		sz = ((((x & 7) >>> 0) >> 0));
		accept = $clone((x$1 = x >>> 4 << 24 >>> 24, ((x$1 < 0 || x$1 >= acceptRanges.length) ? ($throwRuntimeError("index out of range"), undefined) : acceptRanges[x$1])), acceptRange);
		if (n < sz) {
			_tmp$4 = 65533;
			_tmp$5 = 1;
			r = _tmp$4;
			size = _tmp$5;
			return [r, size];
		}
		s1 = s.charCodeAt(1);
		if (s1 < accept.lo || accept.hi < s1) {
			_tmp$6 = 65533;
			_tmp$7 = 1;
			r = _tmp$6;
			size = _tmp$7;
			return [r, size];
		}
		if (sz <= 2) {
			_tmp$8 = (((((s0 & 31) >>> 0) >> 0)) << 6 >> 0) | ((((s1 & 63) >>> 0) >> 0));
			_tmp$9 = 2;
			r = _tmp$8;
			size = _tmp$9;
			return [r, size];
		}
		s2 = s.charCodeAt(2);
		if (s2 < 128 || 191 < s2) {
			_tmp$10 = 65533;
			_tmp$11 = 1;
			r = _tmp$10;
			size = _tmp$11;
			return [r, size];
		}
		if (sz <= 3) {
			_tmp$12 = ((((((s0 & 15) >>> 0) >> 0)) << 12 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s2 & 63) >>> 0) >> 0));
			_tmp$13 = 3;
			r = _tmp$12;
			size = _tmp$13;
			return [r, size];
		}
		s3 = s.charCodeAt(3);
		if (s3 < 128 || 191 < s3) {
			_tmp$14 = 65533;
			_tmp$15 = 1;
			r = _tmp$14;
			size = _tmp$15;
			return [r, size];
		}
		_tmp$16 = (((((((s0 & 7) >>> 0) >> 0)) << 18 >> 0) | (((((s1 & 63) >>> 0) >> 0)) << 12 >> 0)) | (((((s2 & 63) >>> 0) >> 0)) << 6 >> 0)) | ((((s3 & 63) >>> 0) >> 0));
		_tmp$17 = 4;
		r = _tmp$16;
		size = _tmp$17;
		return [r, size];
	};
	$pkg.DecodeRuneInString = DecodeRuneInString;
	DecodeLastRuneInString = function(s) {
		var _tmp, _tmp$1, _tmp$2, _tmp$3, _tmp$4, _tmp$5, _tmp$6, _tmp$7, _tuple, end, lim, r, s, size, start;
		r = 0;
		size = 0;
		end = s.length;
		if (end === 0) {
			_tmp = 65533;
			_tmp$1 = 0;
			r = _tmp;
			size = _tmp$1;
			return [r, size];
		}
		start = end - 1 >> 0;
		r = ((s.charCodeAt(start) >> 0));
		if (r < 128) {
			_tmp$2 = r;
			_tmp$3 = 1;
			r = _tmp$2;
			size = _tmp$3;
			return [r, size];
		}
		lim = end - 4 >> 0;
		if (lim < 0) {
			lim = 0;
		}
		start = start - (1) >> 0;
		while (true) {
			if (!(start >= lim)) { break; }
			if (RuneStart(s.charCodeAt(start))) {
				break;
			}
			start = start - (1) >> 0;
		}
		if (start < 0) {
			start = 0;
		}
		_tuple = DecodeRuneInString($substring(s, start, end));
		r = _tuple[0];
		size = _tuple[1];
		if (!(((start + size >> 0) === end))) {
			_tmp$4 = 65533;
			_tmp$5 = 1;
			r = _tmp$4;
			size = _tmp$5;
			return [r, size];
		}
		_tmp$6 = r;
		_tmp$7 = size;
		r = _tmp$6;
		size = _tmp$7;
		return [r, size];
	};
	$pkg.DecodeLastRuneInString = DecodeLastRuneInString;
	RuneLen = function(r) {
		var r;
		if (r < 0) {
			return -1;
		} else if (r <= 127) {
			return 1;
		} else if (r <= 2047) {
			return 2;
		} else if (55296 <= r && r <= 57343) {
			return -1;
		} else if (r <= 65535) {
			return 3;
		} else if (r <= 1114111) {
			return 4;
		}
		return -1;
	};
	$pkg.RuneLen = RuneLen;
	EncodeRune = function(p, r) {
		var i, p, r;
		i = ((r >>> 0));
		if (i <= 127) {
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((r << 24 >>> 24)));
			return 1;
		} else if (i <= 2047) {
			$unused((1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((192 | (((r >> 6 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 2;
		} else if ((i > 1114111) || (55296 <= i && i <= 57343)) {
			r = 65533;
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else if (i <= 65535) {
			$unused((2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((224 | (((r >> 12 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 3;
		} else {
			$unused((3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3]));
			(0 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 0] = ((240 | (((r >> 18 >> 0) << 24 >>> 24))) >>> 0));
			(1 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 1] = ((128 | (((((r >> 12 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(2 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 2] = ((128 | (((((r >> 6 >> 0) << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			(3 >= p.$length ? ($throwRuntimeError("index out of range"), undefined) : p.$array[p.$offset + 3] = ((128 | ((((r << 24 >>> 24)) & 63) >>> 0)) >>> 0));
			return 4;
		}
	};
	$pkg.EncodeRune = EncodeRune;
	RuneStart = function(b) {
		var b;
		return !((((b & 192) >>> 0) === 128));
	};
	$pkg.RuneStart = RuneStart;
	acceptRange.init("unicode/utf8", [{prop: "lo", name: "lo", embedded: false, exported: false, typ: $Uint8, tag: ""}, {prop: "hi", name: "hi", embedded: false, exported: false, typ: $Uint8, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		first = $toNativeArray($kindUint8, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 240, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 19, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 35, 3, 3, 52, 4, 4, 4, 68, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241, 241]);
		acceptRanges = $toNativeArray($kindStruct, [$clone(new acceptRange.ptr(128, 191), acceptRange), $clone(new acceptRange.ptr(160, 191), acceptRange), $clone(new acceptRange.ptr(128, 159), acceptRange), $clone(new acceptRange.ptr(144, 191), acceptRange), $clone(new acceptRange.ptr(128, 143), acceptRange), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0), new acceptRange.ptr(0, 0)]);
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["strings"] = (function() {
	var $pkg = {}, $init, errors, js, io, sync, unicode, utf8, Builder, ptrType$1, sliceType$2, asciiSpace, Map, ToLower, TrimLeftFunc, TrimRightFunc, TrimFunc, indexFunc, lastIndexFunc, TrimSpace, Index;
	errors = $packages["errors"];
	js = $packages["github.com/gopherjs/gopherjs/js"];
	io = $packages["io"];
	sync = $packages["sync"];
	unicode = $packages["unicode"];
	utf8 = $packages["unicode/utf8"];
	Builder = $pkg.Builder = $newType(0, $kindStruct, "strings.Builder", true, "strings", true, function(addr_, buf_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.addr = ptrType$1.nil;
			this.buf = sliceType$2.nil;
			return;
		}
		this.addr = addr_;
		this.buf = buf_;
	});
	ptrType$1 = $ptrType(Builder);
	sliceType$2 = $sliceType($Uint8);
	Map = function(mapping, s) {
		var {_i, _i$1, _r, _r$1, _ref, _ref$1, _rune, _rune$1, _tuple, b, c, c$1, i, mapping, r, r$1, s, width, $s, $r, $c} = $restore(this, {mapping, s});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		b = new Builder.ptr(ptrType$1.nil, sliceType$2.nil);
		_ref = s;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.length)) { break; } */ if(!(_i < _ref.length)) { $s = 2; continue; }
			_rune = $decodeRune(_ref, _i);
			i = _i;
			c = _rune[0];
			_r = mapping(c); /* */ $s = 3; case 3: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			r = _r;
			if ((r === c) && !((c === 65533))) {
				_i += _rune[1];
				/* continue; */ $s = 1; continue;
			}
			width = 0;
			if (c === 65533) {
				_tuple = utf8.DecodeRuneInString($substring(s, i));
				c = _tuple[0];
				width = _tuple[1];
				if (!((width === 1)) && (r === c)) {
					_i += _rune[1];
					/* continue; */ $s = 1; continue;
				}
			} else {
				width = utf8.RuneLen(c);
			}
			b.Grow(s.length + 4 >> 0);
			b.WriteString($substring(s, 0, i));
			if (r >= 0) {
				b.WriteRune(r);
			}
			s = $substring(s, (i + width >> 0));
			/* break; */ $s = 2; continue;
		case 2:
		if (b.Cap() === 0) {
			$s = -1; return s;
		}
		_ref$1 = s;
		_i$1 = 0;
		/* while (true) { */ case 4:
			/* if (!(_i$1 < _ref$1.length)) { break; } */ if(!(_i$1 < _ref$1.length)) { $s = 5; continue; }
			_rune$1 = $decodeRune(_ref$1, _i$1);
			c$1 = _rune$1[0];
			_r$1 = mapping(c$1); /* */ $s = 6; case 6: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			r$1 = _r$1;
			if (r$1 >= 0) {
				if (r$1 < 128) {
					b.WriteByte(((r$1 << 24 >>> 24)));
				} else {
					b.WriteRune(r$1);
				}
			}
			_i$1 += _rune$1[1];
		$s = 4; continue;
		case 5:
		$s = -1; return b.String();
		/* */ } return; } var $f = {$blk: Map, $c: true, $r, _i, _i$1, _r, _r$1, _ref, _ref$1, _rune, _rune$1, _tuple, b, c, c$1, i, mapping, r, r$1, s, width, $s};return $f;
	};
	$pkg.Map = Map;
	ToLower = function(s) {
		var {$24r, _r, _tmp, _tmp$1, b, c, c$1, hasUpper, i, i$1, isASCII, s, $s, $r, $c} = $restore(this, {s});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_tmp = true;
		_tmp$1 = false;
		isASCII = _tmp;
		hasUpper = _tmp$1;
		i = 0;
		while (true) {
			if (!(i < s.length)) { break; }
			c = s.charCodeAt(i);
			if (c >= 128) {
				isASCII = false;
				break;
			}
			hasUpper = hasUpper || (65 <= c && c <= 90);
			i = i + (1) >> 0;
		}
		if (isASCII) {
			if (!hasUpper) {
				$s = -1; return s;
			}
			b = new Builder.ptr(ptrType$1.nil, sliceType$2.nil);
			b.Grow(s.length);
			i$1 = 0;
			while (true) {
				if (!(i$1 < s.length)) { break; }
				c$1 = s.charCodeAt(i$1);
				if (65 <= c$1 && c$1 <= 90) {
					c$1 = c$1 + (32) << 24 >>> 24;
				}
				b.WriteByte(c$1);
				i$1 = i$1 + (1) >> 0;
			}
			$s = -1; return b.String();
		}
		_r = Map(unicode.ToLower, s); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		$24r = _r;
		$s = 2; case 2: return $24r;
		/* */ } return; } var $f = {$blk: ToLower, $c: true, $r, $24r, _r, _tmp, _tmp$1, b, c, c$1, hasUpper, i, i$1, isASCII, s, $s};return $f;
	};
	$pkg.ToLower = ToLower;
	TrimLeftFunc = function(s, f) {
		var {_r, f, i, s, $s, $r, $c} = $restore(this, {s, f});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = indexFunc(s, f, false); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		i = _r;
		if (i === -1) {
			$s = -1; return "";
		}
		$s = -1; return $substring(s, i);
		/* */ } return; } var $f = {$blk: TrimLeftFunc, $c: true, $r, _r, f, i, s, $s};return $f;
	};
	$pkg.TrimLeftFunc = TrimLeftFunc;
	TrimRightFunc = function(s, f) {
		var {_r, _tuple, f, i, s, wid, $s, $r, $c} = $restore(this, {s, f});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = lastIndexFunc(s, f, false); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		i = _r;
		if (i >= 0 && s.charCodeAt(i) >= 128) {
			_tuple = utf8.DecodeRuneInString($substring(s, i));
			wid = _tuple[1];
			i = i + (wid) >> 0;
		} else {
			i = i + (1) >> 0;
		}
		$s = -1; return $substring(s, 0, i);
		/* */ } return; } var $f = {$blk: TrimRightFunc, $c: true, $r, _r, _tuple, f, i, s, wid, $s};return $f;
	};
	$pkg.TrimRightFunc = TrimRightFunc;
	TrimFunc = function(s, f) {
		var {$24r, _r, _r$1, f, s, $s, $r, $c} = $restore(this, {s, f});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_r = TrimLeftFunc(s, f); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		_r$1 = TrimRightFunc(_r, f); /* */ $s = 2; case 2: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
		$24r = _r$1;
		$s = 3; case 3: return $24r;
		/* */ } return; } var $f = {$blk: TrimFunc, $c: true, $r, $24r, _r, _r$1, f, s, $s};return $f;
	};
	$pkg.TrimFunc = TrimFunc;
	indexFunc = function(s, f, truth) {
		var {_i, _r, _ref, _rune, f, i, r, s, truth, $s, $r, $c} = $restore(this, {s, f, truth});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		_ref = s;
		_i = 0;
		/* while (true) { */ case 1:
			/* if (!(_i < _ref.length)) { break; } */ if(!(_i < _ref.length)) { $s = 2; continue; }
			_rune = $decodeRune(_ref, _i);
			i = _i;
			r = _rune[0];
			_r = f(r); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (_r === truth) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_r === truth) { */ case 3:
				$s = -1; return i;
			/* } */ case 4:
			_i += _rune[1];
		$s = 1; continue;
		case 2:
		$s = -1; return -1;
		/* */ } return; } var $f = {$blk: indexFunc, $c: true, $r, _i, _r, _ref, _rune, f, i, r, s, truth, $s};return $f;
	};
	lastIndexFunc = function(s, f, truth) {
		var {_r, _tuple, f, i, r, s, size, truth, $s, $r, $c} = $restore(this, {s, f, truth});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		i = s.length;
		/* while (true) { */ case 1:
			/* if (!(i > 0)) { break; } */ if(!(i > 0)) { $s = 2; continue; }
			_tuple = utf8.DecodeLastRuneInString($substring(s, 0, i));
			r = _tuple[0];
			size = _tuple[1];
			i = i - (size) >> 0;
			_r = f(r); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
			/* */ if (_r === truth) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (_r === truth) { */ case 3:
				$s = -1; return i;
			/* } */ case 4:
		$s = 1; continue;
		case 2:
		$s = -1; return -1;
		/* */ } return; } var $f = {$blk: lastIndexFunc, $c: true, $r, _r, _tuple, f, i, r, s, size, truth, $s};return $f;
	};
	TrimSpace = function(s) {
		var {$24r, $24r$1, _r, _r$1, c, c$1, s, start, stop, $s, $r, $c} = $restore(this, {s});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		start = 0;
		/* while (true) { */ case 1:
			/* if (!(start < s.length)) { break; } */ if(!(start < s.length)) { $s = 2; continue; }
			c = s.charCodeAt(start);
			/* */ if (c >= 128) { $s = 3; continue; }
			/* */ $s = 4; continue;
			/* if (c >= 128) { */ case 3:
				_r = TrimFunc($substring(s, start), unicode.IsSpace); /* */ $s = 5; case 5: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
				$24r = _r;
				$s = 6; case 6: return $24r;
			/* } */ case 4:
			if (((c < 0 || c >= asciiSpace.length) ? ($throwRuntimeError("index out of range"), undefined) : asciiSpace[c]) === 0) {
				/* break; */ $s = 2; continue;
			}
			start = start + (1) >> 0;
		$s = 1; continue;
		case 2:
		stop = s.length;
		/* while (true) { */ case 7:
			/* if (!(stop > start)) { break; } */ if(!(stop > start)) { $s = 8; continue; }
			c$1 = s.charCodeAt((stop - 1 >> 0));
			/* */ if (c$1 >= 128) { $s = 9; continue; }
			/* */ $s = 10; continue;
			/* if (c$1 >= 128) { */ case 9:
				_r$1 = TrimRightFunc($substring(s, start, stop), unicode.IsSpace); /* */ $s = 11; case 11: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
				$24r$1 = _r$1;
				$s = 12; case 12: return $24r$1;
			/* } */ case 10:
			if (((c$1 < 0 || c$1 >= asciiSpace.length) ? ($throwRuntimeError("index out of range"), undefined) : asciiSpace[c$1]) === 0) {
				/* break; */ $s = 8; continue;
			}
			stop = stop - (1) >> 0;
		$s = 7; continue;
		case 8:
		$s = -1; return $substring(s, start, stop);
		/* */ } return; } var $f = {$blk: TrimSpace, $c: true, $r, $24r, $24r$1, _r, _r$1, c, c$1, s, start, stop, $s};return $f;
	};
	$pkg.TrimSpace = TrimSpace;
	Builder.ptr.prototype.Len = function() {
		var b;
		b = this;
		return b.buf.$length;
	};
	Builder.prototype.Len = function() { return this.$val.Len(); };
	Builder.ptr.prototype.Cap = function() {
		var b;
		b = this;
		return b.buf.$capacity;
	};
	Builder.prototype.Cap = function() { return this.$val.Cap(); };
	Builder.ptr.prototype.Reset = function() {
		var b;
		b = this;
		b.addr = ptrType$1.nil;
		b.buf = sliceType$2.nil;
	};
	Builder.prototype.Reset = function() { return this.$val.Reset(); };
	Builder.ptr.prototype.grow = function(n) {
		var b, buf, n;
		b = this;
		buf = $makeSlice(sliceType$2, b.buf.$length, (($imul(2, b.buf.$capacity)) + n >> 0));
		$copySlice(buf, b.buf);
		b.buf = buf;
	};
	Builder.prototype.grow = function(n) { return this.$val.grow(n); };
	Builder.ptr.prototype.Grow = function(n) {
		var b, n;
		b = this;
		b.copyCheck();
		if (n < 0) {
			$panic(new $String("strings.Builder.Grow: negative count"));
		}
		if ((b.buf.$capacity - b.buf.$length >> 0) < n) {
			b.grow(n);
		}
	};
	Builder.prototype.Grow = function(n) { return this.$val.Grow(n); };
	Builder.ptr.prototype.Write = function(p) {
		var b, p;
		b = this;
		b.copyCheck();
		b.buf = $appendSlice(b.buf, p);
		return [p.$length, $ifaceNil];
	};
	Builder.prototype.Write = function(p) { return this.$val.Write(p); };
	Builder.ptr.prototype.WriteByte = function(c) {
		var b, c;
		b = this;
		b.copyCheck();
		b.buf = $append(b.buf, c);
		return $ifaceNil;
	};
	Builder.prototype.WriteByte = function(c) { return this.$val.WriteByte(c); };
	Builder.ptr.prototype.WriteRune = function(r) {
		var b, l, n, r;
		b = this;
		b.copyCheck();
		if (((r >>> 0)) < 128) {
			b.buf = $append(b.buf, ((r << 24 >>> 24)));
			return [1, $ifaceNil];
		}
		l = b.buf.$length;
		if ((b.buf.$capacity - l >> 0) < 4) {
			b.grow(4);
		}
		n = utf8.EncodeRune($subslice(b.buf, l, (l + 4 >> 0)), r);
		b.buf = $subslice(b.buf, 0, (l + n >> 0));
		return [n, $ifaceNil];
	};
	Builder.prototype.WriteRune = function(r) { return this.$val.WriteRune(r); };
	Builder.ptr.prototype.WriteString = function(s) {
		var b, s;
		b = this;
		b.copyCheck();
		b.buf = $appendSlice(b.buf, s);
		return [s.length, $ifaceNil];
	};
	Builder.prototype.WriteString = function(s) { return this.$val.WriteString(s); };
	Index = function(s, sep) {
		var s, sep;
		return $parseInt(s.indexOf(sep)) >> 0;
	};
	$pkg.Index = Index;
	Builder.ptr.prototype.String = function() {
		var b;
		b = this;
		return ($bytesToString(b.buf));
	};
	Builder.prototype.String = function() { return this.$val.String(); };
	Builder.ptr.prototype.copyCheck = function() {
		var b;
		b = this;
		if (b.addr === ptrType$1.nil) {
			b.addr = b;
		} else if (!(b.addr === b)) {
			$panic(new $String("strings: illegal use of non-zero Builder copied by value"));
		}
	};
	Builder.prototype.copyCheck = function() { return this.$val.copyCheck(); };
	ptrType$1.methods = [{prop: "Len", name: "Len", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Cap", name: "Cap", pkg: "", typ: $funcType([], [$Int], false)}, {prop: "Reset", name: "Reset", pkg: "", typ: $funcType([], [], false)}, {prop: "grow", name: "grow", pkg: "strings", typ: $funcType([$Int], [], false)}, {prop: "Grow", name: "Grow", pkg: "", typ: $funcType([$Int], [], false)}, {prop: "Write", name: "Write", pkg: "", typ: $funcType([sliceType$2], [$Int, $error], false)}, {prop: "WriteByte", name: "WriteByte", pkg: "", typ: $funcType([$Uint8], [$error], false)}, {prop: "WriteRune", name: "WriteRune", pkg: "", typ: $funcType([$Int32], [$Int, $error], false)}, {prop: "WriteString", name: "WriteString", pkg: "", typ: $funcType([$String], [$Int, $error], false)}, {prop: "String", name: "String", pkg: "", typ: $funcType([], [$String], false)}, {prop: "copyCheck", name: "copyCheck", pkg: "strings", typ: $funcType([], [], false)}];
	Builder.init("strings", [{prop: "addr", name: "addr", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "buf", name: "buf", embedded: false, exported: false, typ: sliceType$2, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = errors.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = js.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = io.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sync.$init(); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = unicode.$init(); /* */ $s = 5; case 5: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = utf8.$init(); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		asciiSpace = $toNativeArray($kindUint8, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$packages["overword"] = (function() {
	var $pkg = {}, $init, js, sort, strings, Config, Highlighter, Match, ptrType, ptrType$1, funcType, funcType$1, sliceType, mapType, sliceType$1, ptrType$2, sliceType$2, highlighter, main, initHighlighter, addDefaultCSS, stopHighlighter, removeHighlights;
	js = $packages["github.com/gopherjs/gopherjs/js"];
	sort = $packages["sort"];
	strings = $packages["strings"];
	Config = $pkg.Config = $newType(0, $kindStruct, "main.Config", true, "overword", true, function(Words_, HighlightClass_, DebounceTime_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Words = sliceType.nil;
			this.HighlightClass = "";
			this.DebounceTime = 0;
			return;
		}
		this.Words = Words_;
		this.HighlightClass = HighlightClass_;
		this.DebounceTime = DebounceTime_;
	});
	Highlighter = $pkg.Highlighter = $newType(0, $kindStruct, "main.Highlighter", true, "overword", true, function(config_, observer_, debounceID_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.config = new Config.ptr(sliceType.nil, "", 0);
			this.observer = null;
			this.debounceID = null;
			return;
		}
		this.config = config_;
		this.observer = observer_;
		this.debounceID = debounceID_;
	});
	Match = $newType(0, $kindStruct, "main.Match", true, "overword", true, function(Start_, End_, Word_) {
		this.$val = this;
		if (arguments.length === 0) {
			this.Start = 0;
			this.End = 0;
			this.Word = "";
			return;
		}
		this.Start = Start_;
		this.End = End_;
		this.Word = Word_;
	});
	ptrType = $ptrType(Highlighter);
	ptrType$1 = $ptrType(js.Object);
	funcType = $funcType([ptrType$1], [], false);
	funcType$1 = $funcType([], [], false);
	sliceType = $sliceType($String);
	mapType = $mapType($String, $emptyInterface);
	sliceType$1 = $sliceType(ptrType$1);
	ptrType$2 = $ptrType(sliceType$1);
	sliceType$2 = $sliceType(Match);
	main = function() {
		$global.initHighlighter = $externalize(initHighlighter, funcType);
		$global.stopHighlighter = $externalize(stopHighlighter, funcType$1);
		$global.initHighlighter();
	};
	initHighlighter = function(wordsObj) {
		var {config, i, word, words, wordsObj, $s, $r, $c} = $restore(this, {wordsObj});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		words = sliceType.nil;
		if (!(wordsObj === null) && !(wordsObj === undefined)) {
			i = 0;
			while (true) {
				if (!(i < $parseInt(wordsObj.length))) { break; }
				word = $internalize(wordsObj[i], $String);
				if (!(word === "")) {
					words = $append(words, word);
				}
				i = i + (1) >> 0;
			}
		}
		if (words.$length === 0) {
			words = new sliceType(["\xD0\xB2\xD0\xB0\xD0\xB6\xD0\xBD\xD0\xBE", "\xD1\x81\xD1\x80\xD0\xBE\xD1\x87\xD0\xBD\xD0\xBE", "\xD0\xB2\xD0\xBD\xD0\xB8\xD0\xBC\xD0\xB0\xD0\xBD\xD0\xB8\xD0\xB5"]);
		}
		config = new Config.ptr(words, "highlightClass", 200);
		highlighter = new Highlighter.ptr($clone(config, Config), null, null);
		addDefaultCSS(config.HighlightClass);
		$r = highlighter.searchAndHighlight($global.document.body); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		highlighter.observeDOMChanges();
		$s = -1; return;
		/* */ } return; } var $f = {$blk: initHighlighter, $c: true, $r, config, i, word, words, wordsObj, $s};return $f;
	};
	Highlighter.ptr.prototype.observeDOMChanges = function() {
		var cb, h;
		h = this;
		cb = js.MakeFunc((function(this$1, args) {
			var args, this$1;
			h.debounceHighlight();
			return $ifaceNil;
		}));
		h.observer = new ($global.MutationObserver)(cb);
		h.observer.observe($global.document.body, $externalize($makeMap($String.keyFor, [{ k: "childList", v: new $Bool(true) }, { k: "subtree", v: new $Bool(true) }, { k: "characterData", v: new $Bool(true) }]), mapType));
	};
	Highlighter.prototype.observeDOMChanges = function() { return this.$val.observeDOMChanges(); };
	Highlighter.ptr.prototype.debounceHighlight = function() {
		var h;
		h = this;
		if (!(h.debounceID === null)) {
			$global.clearTimeout(h.debounceID);
		}
		h.debounceID = $global.setTimeout($externalize((function $b() {
			var {$s, $r, $c} = $restore(this, {});
			/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
			$r = h.searchAndHighlight($global.document.body); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			$s = -1; return;
			/* */ } return; } var $f = {$blk: $b, $c: true, $r, $s};return $f;
		}), funcType$1), h.config.DebounceTime);
	};
	Highlighter.prototype.debounceHighlight = function() { return this.$val.debounceHighlight(); };
	Highlighter.ptr.prototype.collectTextNodes = function(node, result) {
		var {_r, child, children, h, i, node, nodeType, result, tag, $s, $r, $c} = $restore(this, {node, result});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		h = this;
		nodeType = $parseInt(node.nodeType) >> 0;
		if (nodeType === 3) {
			result.$set($append(result.$get(), node));
			$s = -1; return;
		}
		_r = strings.ToLower($internalize(node.nodeName, $String)); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		tag = _r;
		if (tag === "script" || tag === "style" || tag === "noscript" || tag === "iframe") {
			$s = -1; return;
		}
		if (!(node.classList === undefined) && !!(node.classList.contains($externalize(h.config.HighlightClass, $String)))) {
			$s = -1; return;
		}
		children = node.childNodes;
		i = 0;
		/* while (true) { */ case 2:
			/* if (!(i < $parseInt(children.length))) { break; } */ if(!(i < $parseInt(children.length))) { $s = 3; continue; }
			child = children[i];
			$r = h.collectTextNodes(child, result); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			i = i + (1) >> 0;
		$s = 2; continue;
		case 3:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Highlighter.ptr.prototype.collectTextNodes, $c: true, $r, _r, child, children, h, i, node, nodeType, result, tag, $s};return $f;
	};
	Highlighter.prototype.collectTextNodes = function(node, result) { return this.$val.collectTextNodes(node, result); };
	Highlighter.ptr.prototype.searchAndHighlight = function(root) {
		var {_i, _ref, h, node, root, textNodes, $s, $r, $c} = $restore(this, {root});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		textNodes = [textNodes];
		h = this;
		textNodes[0] = sliceType$1.nil;
		$r = h.collectTextNodes(root, (textNodes.$ptr || (textNodes.$ptr = new ptrType$2(function() { return this.$target[0]; }, function($v) { this.$target[0] = $v; }, textNodes)))); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		_ref = textNodes[0];
		_i = 0;
		/* while (true) { */ case 2:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 3; continue; }
			node = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			$r = h.highlightTextNode(node); /* */ $s = 4; case 4: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
			_i++;
		$s = 2; continue;
		case 3:
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Highlighter.ptr.prototype.searchAndHighlight, $c: true, $r, _i, _ref, h, node, root, textNodes, $s};return $f;
	};
	Highlighter.prototype.searchAndHighlight = function(root) { return this.$val.searchAndHighlight(root); };
	Highlighter.ptr.prototype.highlightTextNode = function(textNode) {
		var {_i, _i$1, _i$2, _r, _r$1, _r$2, _ref, _ref$1, _ref$2, doc, end, fragment, h, idx, last, lowerText, m, m$1, matches, merged, parent, pos, prev, span, start, text, textNode, word, wordLower, x, x$1, $s, $r, $c} = $restore(this, {textNode});
		/* */ $s = $s || 0; s: while (true) { switch ($s) { case 0:
		matches = [matches];
		h = this;
		text = $internalize(textNode.nodeValue, $String);
		if (text === "") {
			$s = -1; return;
		}
		$global.console.log(textNode);
		matches[0] = sliceType$2.nil;
		_r = strings.ToLower(text); /* */ $s = 1; case 1: if($c) { $c = false; _r = _r.$blk(); } if (_r && _r.$blk !== undefined) { break s; }
		lowerText = _r;
		_ref = h.config.Words;
		_i = 0;
		/* while (true) { */ case 2:
			/* if (!(_i < _ref.$length)) { break; } */ if(!(_i < _ref.$length)) { $s = 3; continue; }
			word = ((_i < 0 || _i >= _ref.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref.$array[_ref.$offset + _i]);
			_r$1 = strings.TrimSpace(word); /* */ $s = 4; case 4: if($c) { $c = false; _r$1 = _r$1.$blk(); } if (_r$1 && _r$1.$blk !== undefined) { break s; }
			word = _r$1;
			if (word === "") {
				_i++;
				/* continue; */ $s = 2; continue;
			}
			_r$2 = strings.ToLower(word); /* */ $s = 5; case 5: if($c) { $c = false; _r$2 = _r$2.$blk(); } if (_r$2 && _r$2.$blk !== undefined) { break s; }
			wordLower = _r$2;
			idx = 0;
			while (true) {
				pos = strings.Index($substring(lowerText, idx), wordLower);
				if (pos === -1) {
					break;
				}
				start = idx + pos >> 0;
				end = start + word.length >> 0;
				matches[0] = $append(matches[0], new Match.ptr(start, end, $substring(text, start, end)));
				idx = end;
			}
			_i++;
		$s = 2; continue;
		case 3:
		if (matches[0].$length === 0) {
			$s = -1; return;
		}
		$r = sort.Slice(matches[0], (function(matches) { return function(i, j) {
			var i, j;
			return ((i < 0 || i >= matches[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : matches[0].$array[matches[0].$offset + i]).Start < ((j < 0 || j >= matches[0].$length) ? ($throwRuntimeError("index out of range"), undefined) : matches[0].$array[matches[0].$offset + j]).Start;
		}; })(matches)); /* */ $s = 6; case 6: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$global.console.log($externalize(matches[0], sliceType$2));
		merged = sliceType$2.nil;
		_ref$1 = matches[0];
		_i$1 = 0;
		while (true) {
			if (!(_i$1 < _ref$1.$length)) { break; }
			m = $clone(((_i$1 < 0 || _i$1 >= _ref$1.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$1.$array[_ref$1.$offset + _i$1]), Match);
			if ((merged.$length === 0) || m.Start >= (x = merged.$length - 1 >> 0, ((x < 0 || x >= merged.$length) ? ($throwRuntimeError("index out of range"), undefined) : merged.$array[merged.$offset + x])).End) {
				merged = $append(merged, m);
			} else {
				last = (x$1 = merged.$length - 1 >> 0, ((x$1 < 0 || x$1 >= merged.$length) ? ($throwRuntimeError("index out of range"), undefined) : merged.$array[merged.$offset + x$1]));
				if (m.End > last.End) {
					last.End = m.End;
				}
			}
			_i$1++;
		}
		$global.console.log($externalize(merged, sliceType$2));
		doc = $global.document;
		fragment = doc.createDocumentFragment();
		prev = 0;
		_ref$2 = merged;
		_i$2 = 0;
		while (true) {
			if (!(_i$2 < _ref$2.$length)) { break; }
			m$1 = $clone(((_i$2 < 0 || _i$2 >= _ref$2.$length) ? ($throwRuntimeError("index out of range"), undefined) : _ref$2.$array[_ref$2.$offset + _i$2]), Match);
			if (m$1.Start > prev) {
				fragment.appendChild(doc.createTextNode($externalize($substring(text, prev, m$1.Start), $String)));
			}
			span = doc.createElement($externalize("span", $String));
			span.classList.add($externalize(h.config.HighlightClass, $String));
			span.textContent = $externalize($substring(text, m$1.Start, m$1.End), $String);
			fragment.appendChild(span);
			prev = m$1.End;
			_i$2++;
		}
		if (prev < text.length) {
			fragment.appendChild(doc.createTextNode($externalize($substring(text, prev), $String)));
		}
		parent = textNode.parentNode;
		if (!(parent === null)) {
			parent.replaceChild(fragment, textNode);
		}
		$s = -1; return;
		/* */ } return; } var $f = {$blk: Highlighter.ptr.prototype.highlightTextNode, $c: true, $r, _i, _i$1, _i$2, _r, _r$1, _r$2, _ref, _ref$1, _ref$2, doc, end, fragment, h, idx, last, lowerText, m, m$1, matches, merged, parent, pos, prev, span, start, text, textNode, word, wordLower, x, x$1, $s};return $f;
	};
	Highlighter.prototype.highlightTextNode = function(textNode) { return this.$val.highlightTextNode(textNode); };
	addDefaultCSS = function(className) {
		var className, style, styleID;
		styleID = "gopherjs-highlighter-style";
		if (!($global.document.getElementById($externalize(styleID, $String)) === null)) {
			return;
		}
		style = $global.document.createElement($externalize("style", $String));
		style.id = $externalize(styleID, $String);
		style.textContent = $externalize("." + className + " { background-color: yellow; color: black; }", $String);
		$global.document.head.appendChild(style);
	};
	stopHighlighter = function() {
		if (!(highlighter === ptrType.nil) && !(highlighter.observer === null)) {
			highlighter.observer.disconnect();
		}
		removeHighlights("highlightClass");
	};
	removeHighlights = function(className) {
		var className, doc, highlight, i, nodes, parent, text, textNode;
		doc = $global.document;
		nodes = doc.querySelectorAll($externalize("." + className, $String));
		i = 0;
		while (true) {
			if (!(i < $parseInt(nodes.length))) { break; }
			highlight = nodes[i];
			parent = highlight.parentNode;
			if (!(parent === null)) {
				text = highlight.textContent;
				textNode = doc.createTextNode(text);
				parent.replaceChild(textNode, highlight);
			}
			i = i + (1) >> 0;
		}
	};
	ptrType.methods = [{prop: "observeDOMChanges", name: "observeDOMChanges", pkg: "overword", typ: $funcType([], [], false)}, {prop: "debounceHighlight", name: "debounceHighlight", pkg: "overword", typ: $funcType([], [], false)}, {prop: "collectTextNodes", name: "collectTextNodes", pkg: "overword", typ: $funcType([ptrType$1, ptrType$2], [], false)}, {prop: "searchAndHighlight", name: "searchAndHighlight", pkg: "overword", typ: $funcType([ptrType$1], [], false)}, {prop: "highlightTextNode", name: "highlightTextNode", pkg: "overword", typ: $funcType([ptrType$1], [], false)}];
	Config.init("", [{prop: "Words", name: "Words", embedded: false, exported: true, typ: sliceType, tag: ""}, {prop: "HighlightClass", name: "HighlightClass", embedded: false, exported: true, typ: $String, tag: ""}, {prop: "DebounceTime", name: "DebounceTime", embedded: false, exported: true, typ: $Int, tag: ""}]);
	Highlighter.init("overword", [{prop: "config", name: "config", embedded: false, exported: false, typ: Config, tag: ""}, {prop: "observer", name: "observer", embedded: false, exported: false, typ: ptrType$1, tag: ""}, {prop: "debounceID", name: "debounceID", embedded: false, exported: false, typ: ptrType$1, tag: ""}]);
	Match.init("", [{prop: "Start", name: "Start", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "End", name: "End", embedded: false, exported: true, typ: $Int, tag: ""}, {prop: "Word", name: "Word", embedded: false, exported: true, typ: $String, tag: ""}]);
	$init = function() {
		$pkg.$init = function() {};
		/* */ var $f, $c = false, $s = 0, $r; if (this !== undefined && this.$blk !== undefined) { $f = this; $c = true; $s = $f.$s; $r = $f.$r; } s: while (true) { switch ($s) { case 0:
		$r = js.$init(); /* */ $s = 1; case 1: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = sort.$init(); /* */ $s = 2; case 2: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		$r = strings.$init(); /* */ $s = 3; case 3: if($c) { $c = false; $r = $r.$blk(); } if ($r && $r.$blk !== undefined) { break s; }
		highlighter = ptrType.nil;
		if ($pkg === $mainPkg) {
			main();
			$mainFinished = true;
		}
		/* */ } return; } if ($f === undefined) { $f = { $blk: $init }; } $f.$s = $s; $f.$r = $r; return $f;
	};
	$pkg.$init = $init;
	return $pkg;
})();
$synthesizeMethods();
$initAllLinknames();
var $mainPkg = $packages["overword"];
$packages["runtime"].$init();
$go($mainPkg.$init, []);
$flushConsole();

}).call(this);
//# sourceMappingURL=overword.js.map
