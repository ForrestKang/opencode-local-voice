use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(((data.len() + 9 + 63) / 64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, val) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&val.to_be_bytes());
    }
    out
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha256(key);
        key_block[..32].copy_from_slice(&hashed);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }
    let mut inner = Vec::with_capacity(64 + msg.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(msg);
    let inner_hash = sha256(&inner);

    let mut outer = Vec::with_capacity(64 + 32);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha256(&outer)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn random_hex(nbytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; nbytes];
    getrandom::getrandom(&mut buf).map_err(|e| format!("CSPRNG failed: {e}"))?;
    Ok(hex_encode(&buf))
}

pub fn random_urlsafe_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("CSPRNG failed: {e}"))?;
    Ok(base64_encode_urlsafe(&buf))
}

pub fn valid_token(token: &str) -> bool {
    let len = token.len();
    (32..=128).contains(&len)
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn read_or_create_token(home: &Path) -> Result<String, String> {
    fs::create_dir_all(home).map_err(|e| format!("cannot create voice home: {e}"))?;
    let token_path = home.join("token");
    if token_path.exists() {
        let raw = fs::read_to_string(&token_path)
            .map_err(|e| format!("failed to read token file: {e}"))?;
        let trimmed = raw.trim();
        if !valid_token(trimmed) {
            return Err("existing voice token is invalid or corrupt".to_string());
        }
        return Ok(trimmed.to_string());
    }
    let token = random_urlsafe_token()?;
    write_atomic(&token_path, format!("{token}\n").as_bytes())?;
    Ok(token)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let suffix = random_hex(8).unwrap_or_else(|_| "tmp".to_string());
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = path.with_file_name(format!(".{file_name}.{suffix}.tmp"));
    let write_res = (|| -> Result<(), String> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("create temp file {} failed: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| format!("write failed: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync failed: {e}"))?;
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, path).map_err(|e| format!("atomic rename failed: {e}"))?;
        Ok(())
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_res
}

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64_encode_std(input: &[u8]) -> String {
    base64_encode_with(input, B64_STD, true)
}

pub fn base64_encode_urlsafe(input: &[u8]) -> String {
    base64_encode_with(input, B64_URL, false)
}

fn base64_encode_with(input: &[u8], table: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(table[((triple >> 18) & 0x3f) as usize] as char);
        out.push(table[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(table[((triple >> 6) & 0x3f) as usize] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(table[(triple & 0x3f) as usize] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

pub fn base64_decode_std(input: &str) -> Result<Vec<u8>, String> {
    let mut vals = Vec::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_whitespace() {
            continue;
        }
        if b == b'=' {
            vals.push(255u8);
            continue;
        }
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("invalid base64 character".to_string()),
        };
        vals.push(v);
    }
    if vals.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity((vals.len() / 4) * 3);
    for chunk in vals.chunks_exact(4) {
        let a = chunk[0] as u32;
        let b = chunk[1] as u32;
        if a > 63 || b > 63 {
            return Err("invalid base64 padding".to_string());
        }
        let c = if chunk[2] == 255 { 0 } else { chunk[2] as u32 };
        let d = if chunk[3] == 255 { 0 } else { chunk[3] as u32 };
        let triple = (a << 18) | (b << 12) | (c << 6) | d;
        out.push(((triple >> 16) & 0xff) as u8);
        if chunk[2] != 255 {
            out.push(((triple >> 8) & 0xff) as u8);
        }
        if chunk[3] != 255 {
            out.push((triple & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32", kind = "raw-dylib")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32", kind = "raw-dylib")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = data.to_vec();
        let input = DataBlob {
            cb_data: buf.len() as u32,
            pb_data: buf.as_mut_ptr(),
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let descr: Vec<u16> = "OpenCode Local Voice\0".encode_utf16().collect();
        let ok = unsafe {
            CryptProtectData(
                &input,
                descr.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows DPAPI CryptProtectData failed".to_string());
        }
        let result = unsafe {
            let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let vec = slice.to_vec();
            LocalFree(output.pb_data as *mut c_void);
            vec
        };
        Ok(result)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = data.to_vec();
        let input = DataBlob {
            cb_data: buf.len() as u32,
            pb_data: buf.as_mut_ptr(),
        };
        let mut output = DataBlob {
            cb_data: 0,
            pb_data: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows DPAPI CryptUnprotectData failed".to_string());
        }
        let result = unsafe {
            let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
            let vec = slice.to_vec();
            LocalFree(output.pb_data as *mut c_void);
            vec
        };
        Ok(result)
    }
}

pub struct SecretStore {
    path: PathBuf,
}

impl SecretStore {
    pub fn new(home: &Path, filename: &str) -> Self {
        Self {
            path: home.join(filename),
        }
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn read(&self) -> Result<String, String> {
        if !self.path.exists() {
            return Ok(String::new());
        }
        let raw = fs::read(&self.path).map_err(|e| format!("failed to read secret: {e}"))?;
        if let Some(rest) = raw.strip_prefix(b"DPAPI1:") {
            #[cfg(windows)]
            {
                let b64 = std::str::from_utf8(rest)
                    .map_err(|_| "corrupt DPAPI secret encoding".to_string())?
                    .trim();
                let encrypted = base64_decode_std(b64)?;
                let plain = dpapi::unprotect(&encrypted)?;
                return String::from_utf8(plain)
                    .map(|s| s.trim().to_string())
                    .map_err(|_| "corrupt secret UTF-8".to_string());
            }
            #[cfg(not(windows))]
            {
                let _ = rest;
                return Err("DPAPI secret cannot be decrypted on non-Windows host".to_string());
            }
        }
        let text = String::from_utf8(raw)
            .map(|s| s.trim().to_string())
            .map_err(|_| "corrupt secret UTF-8".to_string())?;
        Ok(text)
    }

    pub fn write(&self, value: &str) -> Result<(), String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            if self.path.exists() {
                fs::remove_file(&self.path).map_err(|e| format!("remove secret failed: {e}"))?;
            }
            return Ok(());
        }
        #[cfg(windows)]
        {
            let encrypted = dpapi::protect(trimmed.as_bytes())?;
            let payload = format!("DPAPI1:{}\n", base64_encode_std(&encrypted));
            write_atomic(&self.path, payload.as_bytes())
        }
        #[cfg(not(windows))]
        {
            write_atomic(&self.path, format!("{trimmed}\n").as_bytes())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_and_hmac_match_standard_vectors() {
        assert_eq!(
            hex_encode(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // RFC 4231 Test Case 2
        assert_eq!(
            hex_encode(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn base64_roundtrip() {
        for sample in [b"".as_slice(), b"a", b"ab", b"abc", b"hello world 12345"] {
            let encoded = base64_encode_std(sample);
            let decoded = base64_decode_std(&encoded).unwrap();
            assert_eq!(decoded, sample);
        }
    }

    #[test]
    fn write_atomic_roundtrip() {
        let base = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("oc-voice-atomic-{}", random_hex(6).unwrap()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        write_atomic(&file, b"{\"ok\":true}\n").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"ok\":true}\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
