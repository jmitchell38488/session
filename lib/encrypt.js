'use strict';

const crypto = require('crypto');

/**
 * The maximum length of a cookie. Any encoded cookie that exceeds this length should immediately throw an error
 * @type {number}
 */
const ENC_MAX_LEN = 4093;

/**
 * Convert a hex string to a Buffer object
 * @param {string} text The hex string
 * @return {Buffer} The converted hex string to a Buffer object
 */
const convertHexToBuffer = text => Buffer.from(text, 'hex');

/**
 * Generate the IV Buffer
 * @param {number}len The buffer length
 * @return {Buffer | void} A Buffer of randomly generated bytes of len, or null on failure
 */
const genIv = len => crypto.randomBytes(len);

/**
 * Extracts the IV component of the encoded string
 * @param {string} data The encrypted data to convert into separate components
 * @throw {EvalError} If the data is not correctly formatted
 * @throw {RangeError} if the number of encryption components is not correct
 * @return {{data: Buffer, auth: Buffer, iv: Buffer}} An object representation of the users' session and encoding components
 */
const extractComponents = data => {
  const text = Buffer.from(data, 'base64').toString('utf8');
  if (!text.includes('.')) {
    throw new EvalError('Cannot evaluate encrypted text, invalid data');
  }

  const components = text.split('.');
  if (components.length < 3 || (!components[0] || !components[1] || !components[2])) {
    throw new RangeError('Cannot evaluate encrypted text, invalid number of components');
  }

  return {
    iv: convertHexToBuffer(components[0]),
    auth: convertHexToBuffer(components[1]),
    data: convertHexToBuffer(components[2]),
  };
};

/**
 * Create an instance of the crypto cipheriv class
 * @param {string} method The encryption method to use
 * @param {string} secret The encryption key
 * @param {Buffer} iv The a buffer of randomly generated bytes
 * @return {Cipher} The instance of the cipher
 */
const genCipher = (method, secret, iv) => crypto.createCipheriv(method, secret, iv);

/**
 * Create an instance of the crypto decipheriv class
 * @param {string} method The encryption method to use
 * @param {string} secret The encryption key
 * @param {Buffer} iv The a buffer of randomly generated bytes
 * @return {Decipher} The instance of the decipher
 */
const genDecipher = (method, secret, iv) => crypto.createDecipheriv(method, secret, iv);

/**
 * Encode a JSON session to string and encrypt it for storage in the session cookie
 * @param {Cipher} cipher The instance of the cipher
 * @param {Object} data The JSON data
 * @return {Buffer} The encrypted buffer of data
 */
const encryptSession = (cipher, data) => Buffer.concat([
  cipher.update(JSON.stringify(data)),
  cipher.final(),
]);

/**
 * Convert the three components used to create the encrypted session data to base64 for storage in the users' session cookie
 * @param {Buffer} iv The initialization vector
 * @param {Buffer} auth The auth tag
 * @param {Buffer} text The encrypted text
 * @return {string} A base64 encoded representation of the three components concatenanted together
 */
const compileEncryptString = (iv, auth, text) => Buffer.from([
  iv.toString('hex'),
  auth.toString('hex'),
  text.toString('hex'),
].join('.')).toString('base64');

/**
 * A helper function to convert the encrypted text stored in the cookie, from binary data to decrypted utf8 string
 * @param {Decipher} cipher The instance of the cipher that's used to decode
 * @param {Buffer} text The encrypted text
 * @return {string} The decoded session data as a string
 */
const decodeToUtf8 = (cipher, text) => cipher.update(text, 'binary', 'utf8') + cipher.final('utf8');

/**
 * A helper function to convert the decoded session data to an object
 * @param {string} text The decrypted text
 * @return {Object} The session data in JSON format
 * @throws {EvalError} if the JSON cannot be decoded
 */
const decodeToJson = text => {
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new EvalError('Cannot convert decoded cookie string to valid JSON');
  }

  // ??? a parse error that wasn't caught?
  if (!json || json === void 0) {
    throw new EvalError('Cannot convert decoded cookie string to valid JSON');
  }

  return json;
};

/**
 * A helper function to assert if the required values exist for the encryption, descryption efforts
 * @param {Object} opts Options required for encryption/decryption
 * @return {boolean} True if the required values are present
 * @throws {Error} When the required values are not present
 */
const assertOptsExist = opts => {
  if (opts === void 0 || (!opts.algo || !opts.ivlen || !opts.secret)) {
    throw new Error('Cannot encrypt session data, encryption opts {algo, ivlen, secret} is required');
  }

  return true;
};

/**
 * A helper function to extract the AuthTag Buffer from the Cipher instance
 * @param {Cipher} cipher The instance of the cipher
 * @param {string} method The encryption method
 * @return {Buffer} A buffer containing the auth tag, or an empty buffer with zero bytes
 */
const getCipherAuthTag = (cipher, method) => {
  if (method.toLowerCase().indexOf('gcm') !== false ||
    method.toLowerCase().indexOf('ccm') !== false ||
    method.toLowerCase().indexOf('ocb') !== false) {
    return cipher.getAuthTag();
  }

  return Buffer.alloc(0);
};

/**
 * Encodes a JSON representation of the session as secure cookie data in the following format:
 * iv.auth.data
 *
 * The encrypted session is then converted to base64 for storage. It requires the following options:
 * {
 *  algo: string,
 *  ivlen: number,
 *  secret: string,
 * }
 *
 * The IV length must be a valid length to match the algorithm used. If you choose to use 'aes-256-cbc', you must use
 * an IV length of 16, while
 * @param {Object} data The JSON session data
 * @param {Object} opts The option configuration for the encryption steps
 * @throws {TypeError} if the data is invalid or empty
 * @throws {Error} If the encryption is not successful, or cookie max byte length is exceeded, or the required options are not present
 * @return {string} A base64 encoded string of the encrypted session
 */
const encryptData = (data, opts) => {
  if (data !== Object(data)) {
    throw new TypeError('Session data is invalid, cannot encrypt');
  }

  assertOptsExist(opts);

  const iv = genIv(opts.ivlen);
  const cipher = genCipher(opts.algo, opts.secret, iv);
  const encSession = encryptSession(cipher, data); // Must be done before we get the AuthTag
  const encText = compileEncryptString(iv, getCipherAuthTag(cipher, opts.algo), encSession);

  if (Buffer.byteLength(encText) > ENC_MAX_LEN) {
    throw new Error('Cannot encrypt the session, max cookie length exceeded');
  }

  return encText;
};

/**
 * Decrypts the encoded cookie, returns the cookie data as a JSON representation
 * @param {string} text The encrypted cookie data
 * @param {Object} opts The option configuration for the encryption steps
 * @throws {Error} If the text is null, zero-byte or invalid, or the decryption is not successful, or the required options are not present
 * @return {Object} the JSON representation fo the users' session
 */
const decryptData = (text, opts) => {
  if (!text || Buffer.byteLength(text) < 1) {
    throw new Error('Cannot read encrypted cookie, invalid data');
  }

  assertOptsExist(opts);

  const components = extractComponents(text);
  const cipher = genDecipher(opts.algo, opts.secret, components.iv);

  // Only set the AuthTag if we are using one of 'GCM, CCM and OCB'
  if (components.auth && components.auth.length > 0 && (typeof cipher.setAuthTag === 'function')) {
    cipher.setAuthTag(components.auth);
  }

  return decodeToJson(decodeToUtf8(cipher, components.data));
};

module.exports = {
  encryptData,
  decryptData,
};