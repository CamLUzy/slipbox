// Noise_XX_25519_ChaChaPoly_SHA256 (https://noiseprotocol.org/noise.html) with CryptoKit.
// The Windows app uses the `snow` crate for the same protocol; scripts/noise-vectors checks
// that both produce identical bytes.
import CryptoKit
import Foundation

enum NoiseError: Error {
    case decrypt, short, state
}

/// One direction of an established channel (or the handshake's cipher).
struct NoiseCipher {
    var key: SymmetricKey?
    var nonce: UInt64 = 0

    private func nonceBytes() -> ChaChaPoly.Nonce {
        var n = Data(count: 4)
        withUnsafeBytes(of: nonce.littleEndian) { n.append(contentsOf: $0) }
        return try! ChaChaPoly.Nonce(data: n)
    }

    mutating func encrypt(_ plain: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return plain }
        let box = try ChaChaPoly.seal(plain, using: key, nonce: nonceBytes(), authenticating: ad)
        nonce += 1
        return box.ciphertext + box.tag
    }

    mutating func decrypt(_ data: Data, ad: Data = Data()) throws -> Data {
        guard let key else { return data }
        guard data.count >= 16 else { throw NoiseError.short }
        do {
            let box = try ChaChaPoly.SealedBox(nonce: nonceBytes(), ciphertext: data.dropLast(16), tag: data.suffix(16))
            let plain = try ChaChaPoly.open(box, using: key, authenticating: ad)
            nonce += 1
            return plain
        } catch {
            throw NoiseError.decrypt
        }
    }
}

/// The XX handshake: -> e; <- e, ee, s, es; -> s, se. Then split() gives the two ciphers.
struct NoiseHandshake {
    static let protocolName = "Noise_XX_25519_ChaChaPoly_SHA256"

    let initiator: Bool
    let s: Curve25519.KeyAgreement.PrivateKey
    var e: Curve25519.KeyAgreement.PrivateKey?
    var re: Curve25519.KeyAgreement.PublicKey?
    var rs: Curve25519.KeyAgreement.PublicKey?
    private var ck: Data
    private(set) var h: Data
    private var cipher = NoiseCipher()
    private var step = 0
    /// For test vectors only: the ephemeral key to use instead of a random one.
    var fixedEphemeral: Curve25519.KeyAgreement.PrivateKey?

    init(initiator: Bool, staticKey: Curve25519.KeyAgreement.PrivateKey, prologue: Data) {
        self.initiator = initiator
        s = staticKey
        h = Data(Self.protocolName.utf8) // exactly 32 bytes = HASHLEN, used as is
        ck = h
        mixHash(prologue)
    }

    var isFinished: Bool { step == 3 }
    /// The handshake hash: identical on both sides, used for the pairing code.
    var handshakeHash: Data { h }

    private mutating func mixHash(_ data: Data) {
        h = Data(SHA256.hash(data: h + data))
    }

    private static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    private static func hkdf(_ ck: Data, _ ikm: Data) -> (Data, Data) {
        let temp = hmac(ck, ikm)
        let o1 = hmac(temp, Data([1]))
        let o2 = hmac(temp, o1 + Data([2]))
        return (o1, o2)
    }

    private mutating func mixKey(_ ikm: Data) {
        let (a, b) = Self.hkdf(ck, ikm)
        ck = a
        cipher = NoiseCipher(key: SymmetricKey(data: b), nonce: 0)
    }

    private mutating func encryptAndHash(_ plain: Data) throws -> Data {
        let c = try cipher.encrypt(plain, ad: h)
        mixHash(c)
        return c
    }

    private mutating func decryptAndHash(_ data: Data) throws -> Data {
        let p = try cipher.decrypt(data, ad: h)
        mixHash(data)
        return p
    }

    private static func dh(_ k: Curve25519.KeyAgreement.PrivateKey, _ p: Curve25519.KeyAgreement.PublicKey) throws -> Data {
        try k.sharedSecretFromKeyAgreement(with: p).withUnsafeBytes { Data($0) }
    }

    private var hasKey: Bool { cipher.key != nil }
    private var sealedKeyLength: Int { hasKey ? 48 : 32 }

    /// Writes the next handshake message (for this side's turn) carrying `payload`.
    mutating func write(_ payload: Data = Data()) throws -> Data {
        var out = Data()
        switch (step, initiator) {
        case (0, true):
            let e = fixedEphemeral ?? Curve25519.KeyAgreement.PrivateKey()
            self.e = e
            out += e.publicKey.rawRepresentation
            mixHash(e.publicKey.rawRepresentation)
        case (1, false):
            let e = fixedEphemeral ?? Curve25519.KeyAgreement.PrivateKey()
            self.e = e
            out += e.publicKey.rawRepresentation
            mixHash(e.publicKey.rawRepresentation)
            guard let re else { throw NoiseError.state }
            mixKey(try Self.dh(e, re))
            out += try encryptAndHash(s.publicKey.rawRepresentation)
            mixKey(try Self.dh(s, re))
        case (2, true):
            out += try encryptAndHash(s.publicKey.rawRepresentation)
            guard let re else { throw NoiseError.state }
            mixKey(try Self.dh(s, re))
        default:
            throw NoiseError.state
        }
        out += try encryptAndHash(payload)
        step += 1
        return out
    }

    /// Reads the other side's handshake message and returns its payload.
    mutating func read(_ msg: Data) throws -> Data {
        var rest = msg
        func take(_ n: Int) throws -> Data {
            guard rest.count >= n else { throw NoiseError.short }
            let d = Data(rest.prefix(n))
            rest = Data(rest.dropFirst(n))
            return d
        }
        switch (step, initiator) {
        case (0, false):
            let re = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: take(32))
            self.re = re
            mixHash(re.rawRepresentation)
        case (1, true):
            let re = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: take(32))
            self.re = re
            mixHash(re.rawRepresentation)
            guard let e else { throw NoiseError.state }
            mixKey(try Self.dh(e, re))
            let rs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: decryptAndHash(take(sealedKeyLength)))
            self.rs = rs
            mixKey(try Self.dh(e, rs))
        case (2, false):
            let rs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: decryptAndHash(take(sealedKeyLength)))
            self.rs = rs
            guard let e else { throw NoiseError.state }
            mixKey(try Self.dh(e, rs))
        default:
            throw NoiseError.state
        }
        let payload = try decryptAndHash(rest)
        step += 1
        return payload
    }

    /// After the third message: (send, receive) ciphers for this side.
    func split() -> (send: NoiseCipher, receive: NoiseCipher) {
        let (a, b) = Self.hkdf(ck, Data())
        let c1 = NoiseCipher(key: SymmetricKey(data: a)), c2 = NoiseCipher(key: SymmetricKey(data: b))
        return initiator ? (c1, c2) : (c2, c1)
    }
}

/// The 6-digit pairing code both devices show; it only matches when nobody sits in the middle.
func pairingCode(_ handshakeHash: Data) -> String {
    let d = Array(SHA256.hash(data: Data("slipbox-sas".utf8) + handshakeHash))
    let n = (UInt32(d[0]) << 24 | UInt32(d[1]) << 16 | UInt32(d[2]) << 8 | UInt32(d[3])) % 1_000_000
    return String(format: "%06u", n)
}
