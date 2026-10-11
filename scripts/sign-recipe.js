// Release step: sign recipe.json with the owner's Ed25519 private key; upload the output as recipe.json.sig.
// Key setup (owner, once):
//   openssl genpkey -algorithm ed25519 -out release-signing.pem
//   openssl pkey -in release-signing.pem -pubout   # paste into releasePublicKey in src/update.js
// Usage: node scripts/sign-recipe.js recipe.json path/to/release-signing.pem > recipe.json.sig
import fs from 'node:fs';
import crypto from 'node:crypto';
const [recipe, key] = process.argv.slice(2);
if (!recipe || !key) throw new Error('Usage: sign-recipe.js <recipe.json> <private-key.pem>');
process.stdout.write(crypto.sign(null, fs.readFileSync(recipe), crypto.createPrivateKey(fs.readFileSync(key))).toString('base64') + '\n');
