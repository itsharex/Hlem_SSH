use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::{
    config::VaultData,
    errors::{AppError, AppResult},
};

const MAGIC: &str = "RPVAULT";
const VAULT_FORMAT_VERSION: u16 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedVault {
    pub magic: String,
    pub version: u16,
    pub kdf: KdfHeader,
    pub aead: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfHeader {
    pub algorithm: String,
    pub params: String,
}

#[derive(Debug, Clone)]
pub struct CryptoSession {
    pub key: [u8; KEY_LEN],
    pub salt: [u8; SALT_LEN],
}

pub fn encrypt_with_password(
    master_password: &str,
    data: &VaultData,
) -> AppResult<(EncryptedVault, CryptoSession)> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(master_password, &salt)?;
    let encrypted = encrypt_with_key(&key, &salt, data)?;
    Ok((encrypted, CryptoSession { key, salt }))
}

pub fn encrypt_with_key(
    key: &[u8; KEY_LEN],
    salt: &[u8; SALT_LEN],
    data: &VaultData,
) -> AppResult<EncryptedVault> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let plaintext = serde_json::to_vec(data)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|error| AppError::Crypto(format!("初始化加密器失败: {error}")))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| AppError::Crypto("加密本机数据失败".to_string()))?;

    Ok(EncryptedVault {
        magic: MAGIC.to_string(),
        version: VAULT_FORMAT_VERSION,
        kdf: KdfHeader {
            algorithm: "argon2id".to_string(),
            params: "argon2-default".to_string(),
        },
        aead: "xchacha20poly1305".to_string(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

pub fn decrypt_with_password(
    master_password: &str,
    encrypted: &EncryptedVault,
) -> AppResult<(VaultData, CryptoSession)> {
    validate_header(encrypted)?;
    let salt = decode_fixed::<SALT_LEN>(&encrypted.salt)?;
    let nonce = decode_fixed::<NONCE_LEN>(&encrypted.nonce)?;
    let ciphertext = STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let key = derive_key(master_password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let data = serde_json::from_slice(&plaintext).map_err(|_| AppError::InvalidMasterPassword)?;
    Ok((data, CryptoSession { key, salt }))
}

pub fn decrypt_with_key(key: &[u8; KEY_LEN], encrypted: &EncryptedVault) -> AppResult<VaultData> {
    validate_header(encrypted)?;
    let nonce = decode_fixed::<NONCE_LEN>(&encrypted.nonce)?;
    let ciphertext = STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::InvalidMasterPassword)?;
    serde_json::from_slice(&plaintext).map_err(|_| AppError::InvalidMasterPassword)
}

fn derive_key(master_password: &str, salt: &[u8; SALT_LEN]) -> AppResult<[u8; KEY_LEN]> {
    if master_password.is_empty() {
        return Err(AppError::InvalidInput("主密码不能为空".to_string()));
    }

    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|error| AppError::Crypto(format!("派生加密密钥失败: {error}")))?;
    Ok(key)
}

fn validate_header(encrypted: &EncryptedVault) -> AppResult<()> {
    if encrypted.magic != MAGIC || encrypted.version != VAULT_FORMAT_VERSION {
        return Err(AppError::Crypto("不支持的本机数据格式".to_string()));
    }
    if encrypted.kdf.algorithm != "argon2id" || encrypted.aead != "xchacha20poly1305" {
        return Err(AppError::Crypto("不支持的加密算法".to_string()));
    }
    Ok(())
}

fn decode_fixed<const N: usize>(value: &str) -> AppResult<[u8; N]> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    decoded
        .try_into()
        .map_err(|_| AppError::InvalidMasterPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_with_correct_master_password() {
        let data = VaultData::with_default_group();
        let (encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        let (decrypted, _) = decrypt_with_password("pass-123456", &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn rejects_wrong_master_password() {
        let data = VaultData::with_default_group();
        let (encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        assert!(matches!(
            decrypt_with_password("wrong-password", &encrypted),
            Err(AppError::InvalidMasterPassword)
        ));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let data = VaultData::with_default_group();
        let (mut encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        encrypted.ciphertext.push('A');
        assert!(decrypt_with_password("pass-123456", &encrypted).is_err());
    }

    #[test]
    fn decrypts_with_current_key() {
        let data = VaultData::with_default_group();
        let (encrypted, session) = encrypt_with_password("pass-123456", &data).unwrap();
        let decrypted = decrypt_with_key(&session.key, &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }
}
