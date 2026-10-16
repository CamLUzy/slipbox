// Checks apple/Shared/Noise.swift against vectors made with the Rust `snow` crate (the Windows
// app's Noise implementation; src-tauri/src/sync.rs checks the same vectors), so both apps
// can talk to each other. Run: swiftc apple/Shared/Noise.swift tests/noise/main.swift -o build/noise && build/noise
import CryptoKit
import Foundation

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func key(_ b: UInt8) -> Curve25519.KeyAgreement.PrivateKey { try! .init(rawRepresentation: Data(repeating: b, count: 32)) }

let expected = [
    "m1": "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59",
    "m2": "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10bb719b14d19eaf5ca91c89748c5ce8668e6864f05ee2367682b3e0c2fd086f0b4b876be52119643a6132a27cae5db386fd12bc206ae43bf7d43fe80a9d83e8ed10ed703e828fbabb68e3c5e5c3e",
    "m3": "539a5cf3ae8a0a9134b32bfa775a1522db3558a1351ed4101989b8b88aa6a6f06d1a3417e30591388d01736df681226a3c40dd4f83adffe104f2fe37504177e9001c8130d1c4dd432cf46a74c2",
    "h": "bf0082602ca6bbd90648f98e799b444850cf920fbdf5a3e4982200f09317a043",
    "t1": "f5c8fdccae8939c5a6d0d9be2753d6cf345c85961d",
    "t2": "ef940bdf5a86302dad53e2e4243977a108057c9693",
    "code": "355424",
]
let prologue = Data("slipbox-sync-v1".utf8)
var i = NoiseHandshake(initiator: true, staticKey: key(1), prologue: prologue)
i.fixedEphemeral = key(2)
var r = NoiseHandshake(initiator: false, staticKey: key(3), prologue: prologue)
r.fixedEphemeral = key(4)

var got: [String: String] = [:]
let m1 = try i.write(); got["m1"] = hex(m1); _ = try r.read(m1)
let m2 = try r.write(Data(#"{"id":"host"}"#.utf8)); got["m2"] = hex(m2)
let p2 = try i.read(m2)
let m3 = try i.write(Data(#"{"id":"init"}"#.utf8)); got["m3"] = hex(m3)
let p3 = try r.read(m3)
got["h"] = hex(i.handshakeHash)
got["code"] = pairingCode(i.handshakeHash)
precondition(i.handshakeHash == r.handshakeHash && String(decoding: p2, as: UTF8.self) == #"{"id":"host"}"# && String(decoding: p3, as: UTF8.self) == #"{"id":"init"}"#)
precondition(i.rs?.rawRepresentation == key(3).publicKey.rawRepresentation && r.rs?.rawRepresentation == key(1).publicKey.rawRepresentation)
var (iSend, _) = i.split()
var (rSend, rRecv) = r.split()
let t1 = try iSend.encrypt(Data("hello".utf8)); got["t1"] = hex(t1)
let back = try rRecv.decrypt(t1); precondition(back == Data("hello".utf8))
got["t2"] = hex(try rSend.encrypt(Data("world".utf8)))

var ok = true
for k in ["m1", "m2", "m3", "h", "t1", "t2", "code"] where got[k] != expected[k] {
    print("MISMATCH \(k)\n  got      \(got[k] ?? "-")\n  expected \(expected[k]!)")
    ok = false
}
// a tampered message must be rejected
var bad = m3; bad[bad.count - 1] ^= 1
var r2 = NoiseHandshake(initiator: false, staticKey: key(3), prologue: prologue)
r2.fixedEphemeral = key(4)
_ = try r2.read(m1); _ = try r2.write(Data(#"{"id":"host"}"#.utf8))
if (try? r2.read(bad)) != nil { print("tampered message accepted"); ok = false }
print(ok ? "noise vectors ok" : "noise vectors FAILED")
exit(ok ? 0 : 1)
