import jwt from 'jsonwebtoken';
import NodeCache from 'node-cache';

const jwtcache = new NodeCache({ useClones: false }); // jwt缓存
const choicesCache = new NodeCache({ useClones: false,stdTTL:3600 }); // 复读

export function genToken(apiKey, expireSeconds = 24 * 3600) {

  let jwttoken = jwtcache.get(apiKey);
  if (!jwttoken) {
    jwttoken = createJWT(apiKey, expireSeconds)
    jwtcache.set(apiKey, jwt);

    const update = () => {
      const token = createJWT(apiKey, expireSeconds);
      jwtcache.set(apiKey, token);
    };
    setInterval(update, expireSeconds - 120);
  }

  return jwttoken;
}

export function createJWT(apiKey, expireSeconds = 24 * 3600) {
  const [api_key, secret] = apiKey.split('.');
  const now = Date.now();
  const payload = {
    api_key,
    exp: now + expireSeconds * 1000,
    timestamp: now,
  };

  const options = {
    algorithm: 'HS256',
    header: {
      alg: "HS256",
      sign_type: "SIGN",
    },
  };

  const token = jwt.sign(payload, secret, options);
  return token;
}


export function getglmContent(group, user) {
  const key = `${group}-${user}`;
  let contents = choicesCache.get(key);
  if (contents) {
    return contents;
  } else {
    return { choices: [] };
  }
}

export function insertglmContent(group, user, NewChoices, requestid) {
  const key = `${group}-${user}`;
  const contents = {
    choices: NewChoices,
    request_id: requestid,
  }
  choicesCache.set(key, contents)
}

export function deleteglmContent(group, user) {
  const key = `${group}-${user}`;
  choicesCache.del(key)
}

