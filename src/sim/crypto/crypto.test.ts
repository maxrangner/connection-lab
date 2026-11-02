import { describe, expect, it } from 'vitest';
import { openRecords, decryptHttp, sessionStream } from '../proto/tls';
import { TLS_FLIGHTS, TLS_REQUEST, TLS_SECRETS } from '../scenarios/tlsCapture_example_com';
import { aes128GcmDecrypt, chachaPolyOpen, chachaPolySeal, hkdfExpandLabel, hmacSha256, sha256 } from './crypto';

const bytes = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crypto against published test vectors', () => {
  it('SHA-256 (FIPS 180-4 examples)', () => {
    expect(hex(sha256(ascii('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(hex(sha256(new Uint8Array(1000).fill(0x61)))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('HMAC-SHA-256 (RFC 4231 test cases 1 and 2)', () => {
    expect(hex(hmacSha256(new Uint8Array(20).fill(0x0b), ascii('Hi There')))).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hex(hmacSha256(ascii('Jefe'), ascii('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('AES-128-GCM (NIST test cases 2, 3 and 4), and rejects a tampered message', () => {
    const k = bytes('00000000000000000000000000000000');
    const iv = bytes('000000000000000000000000');
    expect(hex(aes128GcmDecrypt(k, iv, new Uint8Array(0), bytes('0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf'))!)).toBe('00000000000000000000000000000000');
    const key = bytes('feffe9928665731c6d6a8f9467308308');
    const nonce = bytes('cafebabefacedbaddecaf888');
    const plain = 'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255';
    const ct3 = '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091473f5985' + '4d5c2af327cd64a62cf35abd2ba6fab4';
    expect(hex(aes128GcmDecrypt(key, nonce, new Uint8Array(0), bytes(ct3))!)).toBe(plain);
    const aad = bytes('feedfacedeadbeeffeedfacedeadbeefabaddad2');
    const ct4 = '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091' + '5bc94fbc3221a5db94fae95ae7121a47';
    expect(hex(aes128GcmDecrypt(key, nonce, aad, bytes(ct4))!)).toBe(plain.slice(0, 120));
    const bad = bytes(ct4);
    bad[3] = bad[3]! ^ 1;
    expect(aes128GcmDecrypt(key, nonce, aad, bad)).toBeNull();
  });

  it('HKDF-Expand-Label (RFC 8448 simple 1-RTT: server handshake key and iv)', () => {
    const secret = bytes('b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38');
    expect(hex(hkdfExpandLabel(secret, 'key', 16))).toBe('3fce516009c21727d0f2e4e86ee403bc');
    expect(hex(hkdfExpandLabel(secret, 'iv', 12))).toBe('5d313eb2671276ee13000b30');
  });
});

describe('the captured HTTPS session really decrypts', () => {
  const session = { host: 'example.com', flights: TLS_FLIGHTS, secrets: TLS_SECRETS };

  it('the client sent exactly our GET request, encrypted', () => {
    const got = new TextDecoder().decode(decryptHttp(session, 'client', sessionStream(session, 'client')));
    expect(got).toBe(TLS_REQUEST);
  });

  it('the server sent the certificate under handshake keys and a 200 OK page under application keys', () => {
    const recs = openRecords(session, 'server', sessionStream(session, 'server'));
    expect(recs.flatMap((r) => r.handshakes)).toEqual(expect.arrayContaining(['ServerHello', 'Certificate', 'CertificateVerify', 'Finished', 'NewSessionTicket']));
    const page = new TextDecoder().decode(decryptHttp(session, 'server', sessionStream(session, 'server')));
    expect(page.startsWith('HTTP/1.1 200 OK')).toBe(true);
    expect(page).toContain('<title>Example Domain</title>');
  });

  it('opens what it is given and no more, whatever has been opened before', () => {
    const all = sessionStream(session, 'server');
    const whole = openRecords(session, 'server', all);
    const first = whole[1]!.offset;
    const part = openRecords(session, 'server', all.subarray(0, first));
    expect(part).toHaveLength(1);
    expect(part.map((r) => r.offset)).toEqual([0]);
    expect(openRecords(session, 'server', all.slice())).toBe(whole);
    expect(openRecords(session, 'server', new Uint8Array(0))).toEqual([]);
  });
});

describe('ChaCha20-Poly1305 (RFC 8439 section 2.8.2)', () => {
  const key = bytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = bytes('070000004041424344454647');
  const aad = bytes('50515253c0c1c2c3c4c5c6c7');
  const plain = ascii("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const sealed =
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116' +
    '1ae10b594f09e26a7e902ecbd0600691';

  it('seals to the published bytes and opens them again', () => {
    expect(hex(chachaPolySeal(key, nonce, aad, plain))).toBe(sealed);
    expect(hex(chachaPolyOpen(key, nonce, aad, bytes(sealed))!)).toBe(hex(plain));
  });

  it('rejects a changed bit', () => {
    const bad = bytes(sealed);
    bad[7] = bad[7]! ^ 1;
    expect(chachaPolyOpen(key, nonce, aad, bad)).toBeNull();
  });
});
