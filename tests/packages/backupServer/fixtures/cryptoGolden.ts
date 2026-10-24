/**
 * Golden fixture：**一次性**用迁移前的 CryptoJS 4.2.0 实现（原 utils.ts / CookieCloud.ts 原样代码，
 * 随机数替换为下方 inputs 中固定的 salt/iv，Date.now 固定为 inputs.FIXED_NOW）生成后硬编码于此。
 *
 * 这些字符串就是「旧版本写出的数据 / 旧版本给出的结果」，新实现必须原样复现。
 * **不得用新实现重新生成**（那样会让兼容性测试变成自证）；新增用例请另外追加常量。
 */
export const GOLDEN = {
  md5: [
    "d41d8cd98f00b204e9800998ecf8427e",
    "900150983cd24fb0d6963f7d28e17f72",
    "7ae627a4ee52e9cf895b195f7369a446",
    "0ce3ea81803acbdd8f6e4fe1533e5284",
    "398533d48111e9f664b1f64cb10c4b63",
  ],
  sha256: [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "5debf3b773ce76225c138e2e2ca14550de57f853c1cb5c91393b8243deb98f31",
    "282efe6aa0e03250e89e63e71721b74a7f26538d4ec5e846894d263f9f899cf6",
    "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f",
  ],
  extDigest: "de5add29d873dfdb7242963ac08a8472dc726c49dd19f9857583f34a5d39c482",
  hmacStrKey: "d9b0a2acdc94dcc0c474dbbdf206860d422a156d28545d8b6d8bfc6af4d5f18d",
  hmacBytesKey: "783dd6c88491fa5e170f3aec15593da2ed73eb1812d15524a1088c95df44b338",
  pbkdf2: "2e488f49274ac0a9755bcb75c5be375ad8c47a2ea763b8cf98b0f23430475609",
  cipherKey: "582255205e1131eb8dd96ae9d52e797bcec26bb42ed1b0d0ab916f84f7157f60",
  macKey: "7f51fed20067d49c652056fc1406353534d0d06c078c3a3ac76a8b2f8ac7417c",
  evp: {
    key: "6b3951374afc9e9d47b1d5bac91e786261b714bbb5e942578d91f59b3c1e4ed7",
    iv: "128d2c122ef9918710d4e0e31e807093",
  },
  aes256: "Owuzzh6Ai0TaVc+mXWd9ig==",
  aes128: "o2yxO5GYee7ScZKbOGKqXg==",
  aesEmpty: "9oiZJR0yMCygTBDkUKR0rg==",
  aes16: "/V9A+SPkiahUI8X9Bll04aHAo1bBw2Cayie+yJuTeGU=",
  rawDecrypt: [
    {
      ciphertext: "",
      plaintext: "",
    },
    {
      ciphertext: "fd5f40f923e489a85423c5fd065974e1a1c0a356c1c3609aca27bec89b937865",
      plaintext: "30313233343536373839616263646566",
    },
    {
      ciphertext: "fd5f40f923e489a85423c5fd065974e1",
      plaintext: "",
    },
    {
      ciphertext: "fd5f40f923e489a85423c5fd065974e1a1c0a356c1c3609aca27bec89b9378",
      plaintext: "",
    },
    {
      ciphertext: "fd5f40f923e489a85423c5fd065974e1a1",
      plaintext: "3031323334353637383961",
    },
    {
      ciphertext: "3b0bb3ce1e808b44da55cfa65d677d8b",
      plaintext: "",
    },
    {
      ciphertext: "7d5f40f923e489a85423c5fd065974e1a1c0a356c1c3609aca27bec89b937865",
      plaintext: "02fe6837c1eede0c8274a4339061bcc4",
    },
    {
      ciphertext: "00112233445566778899aabbccddeeff0011",
      plaintext: "",
    },
  ],
  base64Lenient: [
    {
      input: "",
      hex: "",
    },
    {
      input: "QQ",
      hex: "41",
    },
    {
      input: "QUI",
      hex: "4142",
    },
    {
      input: "QUJD",
      hex: "414243",
    },
    {
      input: "QU=JD",
      hex: "41",
    },
    {
      input: "Q!JD",
      hex: "400243",
    },
    {
      input: "QUJD\nRUZH",
      hex: "414243011519",
    },
    {
      input: "中文QUJD",
      hex: "00041424",
    },
    {
      input: "QUJDRA==",
      hex: "41424344",
    },
    {
      input: "_-_-",
      hex: "000000",
    },
  ],
  utf8Bom: "﻿A\u0000BC",
  v1Config:
    'PTD-AES-HMAC-v1:{"salt":"jx4tPEtaaXiHlqW0w9Lh8A==","iv":"ASNFZ4mrze/+3LqYdlQyEA==","ciphertext":"jpx2iz2VvQxUsbZFsdpkzj0XDSGgnysbkUIkEtQMXlyzvLGJK+hVzOXrjaBfXHBeH8rOrmpxTLNF93mtQxp5ub+fCEPorJ6u2l7Y+j4rOjU=","mac":"340a3bb4f5d697d4b310558f085b371768e03cc6929f053f543e5cc9b7a58b39"}',
  v1NoField:
    'PTD-AES-HMAC-v1:{"salt":"ABEiM0RVZneImaq7zN3u/w==","iv":"/+7dzLuqmYh3ZlVEMyIRAA==","ciphertext":"0VSlbBCgL2sFIgIVTfpPpA==","mac":"e000b6cffd401d45224b04d4b645e05cbbfa07a1b97c92b6f9a0da2d14e439cb"}',
  v1Errors: {
    wrongPassword: {
      name: "Error",
      message: "Backup integrity/authentication check failed",
    },
    wrongField: {
      name: "Error",
      message: "Backup integrity/authentication check failed",
    },
    noKey: {
      name: "Error",
      message: "Backup encryption key is required",
    },
  },
  v2: {
    manifest:
      '{"version":"chenbinPT (v0.0.10)","encryption":true,"encryptionFormat":"PTD-AES-HMAC-v2","kdf":{"name":"PBKDF2-SHA256","iterations":100000,"salt":"X03MO1qnZdYdgyfeuILPmQ=="},"time":1760000000000,"files":{"config":{"name":"config.json","hash":"450cb3a0eab2078f72a7381fefae3408"},"userInfo":{"name":"userInfo.json","hash":"e136abaded186e204b0db6523c8c6f48"}}}',
    config:
      'PTD-AES-HMAC-v2:{"iv":"oKGio6SlpqeoqaqrrK2urw==","ciphertext":"6G26PcgKzYUFypaopmV7eKOlWw7RRUKUCjkqNq4KOX1ri/M8i+4kCQdrbZzJqVLwJBLcQAIrlCmiIDcr/HvBUOWTEhZ7KNHLswzLKs+dM4k=","mac":"0861a1382cbe1fab4f652acdf0c8db39c028ec7dfe196fd7172fed1ba5325d3a"}',
    userInfo:
      'PTD-AES-HMAC-v2:{"iv":"sLGys7S1tre4ubq7vL2+vw==","ciphertext":"hyn4POlnnBfa8hZ6pLheE5t8t+QjXjOCaTDKq8F54Xd6LQBR7LIdFjscIPIpILUGx9WEgDdqgyHXiq7cijTDsA==","mac":"dcc5eb9cfd5f01de33895bad8e018a790399af1847588125ddb9f61582e4458d"}',
  },
  v2Restore: {
    ok: {
      config: {
        lang: "zh_CN",
        note: "备份 🚀",
        nested: {
          list: [1, 2, 3],
          flag: true,
        },
      },
      userInfo: {
        mteam: {
          "2026-10-04": {
            uploaded: 123456789,
            ratio: 1.5,
          },
        },
      },
    },
  },
  v2WrongKey: {
    name: "Error",
    message: "Failed to decrypt file: config.json",
  },
  legacyKey: "39ee1d4e8bce4c60",
  legacy:
    "U2FsdGVkX18RIjNEVWZ3iJqzg/6o9rl1wmnxKxqT1SZnuD/AUxbSsWOGYskjXCotDk22IcpBhV5r7JGAy/CIkcjh4rz/D9JkAEYdYOmquktD/rVPJkubY2aKoW9HtYLV",
  legacyEmpty: "U2FsdGVkX1+Id2ZVRDMiEWdt2ioPmFAlxMBM0voAnPA=",
  legacySmall: "U2FsdGVkX18KCwwNDg8QEW3/2S+ltRLTcmzLMhUjZcw=",
  legacyCorrupt: {
    truncated:
      "U2FsdGVkX18RIjNEVWZ3iJqzg/6o9rl1wmnxKxqT1SZnuD/AUxbSsWOGYskjXCotDk22IcpBhV5r7JGAy/CIkcjh4rz/D9JkAEYdYOmquktD/rVPJkubY2aKoW9H",
    flipped:
      "U2FsdGVkX18RIjNEVWZ3iJqzg/6o9rl1wmnxKxqTASZnuD/AUxbSsWOGYskjXCotDk22IcpBhV5r7JGAy/CIkcjh4rz/D9JkAEYdYOmquktD/rVPJkubY2aKoW9HtYLV",
    invalidChar:
      "U2FsdGVkX18RIjNEVWZ3iJqzg/6o9rl1wmnxKxqT1SZnuD/AUxbSsWOGYskjXCotDk22IcpBhV5r7JGAy/CIkcjh4rz/D9JkAEYd!OmquktD/rVPJkubY2aKoW9HtYLV",
    earlyPadding:
      "U2FsdGVkX18RIjNEVWZ3iJqzg/6o9rl1wmnxKxqT1SZnuD/AUxbSsWOGYskjXCot=Dk22IcpBhV5r7JGAy/CIkcjh4rz/D9JkAEYdYOmquktD/rVPJkubY2aKoW9HtYLV",
  },
  legacyCorruptResults: {
    truncated: {
      name: "SyntaxError",
      message: "Unexpected end of JSON input",
    },
    flipped: {
      name: "Error",
      message: "Malformed UTF-8 data",
    },
    invalidChar: {
      name: "Error",
      message: "Malformed UTF-8 data",
    },
    earlyPadding: {
      name: "SyntaxError",
      message: "Unexpected end of JSON input",
    },
  },
  legacyEmptyResult: {
    name: "SyntaxError",
    message: "Unexpected end of JSON input",
  },
  legacyOk: {
    ok: {
      lang: "zh_CN",
      note: "备份 🚀",
      nested: {
        list: [1, 2, 3],
        flag: true,
      },
    },
  },
  legacyDowngrade: {
    name: "BackupDowngradeError",
    message: "Encrypted backup entry is missing authenticated v1/v2 envelope",
  },
  legacyWrongPw: {
    empty: [
      {
        pw: "wrong-0",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-1",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-3",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-192",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-320",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-476",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-816",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-921",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-25300",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
    ],
    malformed: [
      {
        pw: "wrong-2",
        r: {
          name: "Error",
          message: "Malformed UTF-8 data",
        },
      },
      {
        pw: "wrong-6",
        r: {
          name: "Error",
          message: "Malformed UTF-8 data",
        },
      },
    ],
    syntax: [
      {
        pw: "wrong-41",
        r: {
          name: "SyntaxError",
          message: "Unexpected token 'u', \"uu\" is not valid JSON",
        },
      },
      {
        pw: "wrong-241",
        r: {
          name: "SyntaxError",
          message: "Unexpected token '#', \"#\" is not valid JSON",
        },
      },
      {
        pw: "wrong-751",
        r: {
          name: "SyntaxError",
          message: "Unexpected token 'p', \"p`\" is not valid JSON",
        },
      },
    ],
    ok: [
      {
        pw: "wrong-8953",
        r: {
          ok: 1,
        },
      },
      {
        pw: "wrong-8980",
        r: {
          ok: 5,
        },
      },
      {
        pw: "wrong-12094",
        r: {
          ok: 6,
        },
      },
    ],
  },
  legacySmallWrongPw: {
    empty: [
      {
        pw: "wrong-0",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-2",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-3",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-6",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-41",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-241",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-751",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-8953",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-8980",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
      {
        pw: "wrong-12094",
        r: {
          name: "SyntaxError",
          message: "Unexpected end of JSON input",
        },
      },
    ],
    malformed: [
      {
        pw: "wrong-1",
        r: {
          name: "Error",
          message: "Malformed UTF-8 data",
        },
      },
    ],
    syntax: [
      {
        pw: "wrong-192",
        r: {
          name: "SyntaxError",
          message: "Unexpected token 'x', \"x+&xR\" is not valid JSON",
        },
      },
      {
        pw: "wrong-476",
        r: {
          name: "SyntaxError",
          message: "Unexpected token 'h', \"h\" is not valid JSON",
        },
      },
      {
        pw: "wrong-816",
        r: {
          name: "SyntaxError",
          message: "Unexpected token '\u001e', \"\u001e\" is not valid JSON",
        },
      },
    ],
    ok: [
      {
        pw: "wrong-320",
        r: {
          ok: 6,
        },
      },
      {
        pw: "wrong-921",
        r: {
          ok: 4,
        },
      },
      {
        pw: "wrong-25300",
        r: {
          ok: 7,
        },
      },
    ],
  },
  ccKey: "ec6247276ab112e3",
  ccIntegrityKey: "1365050bdad5a0cdad7db84727c020673a21a06cb772775385df72f7cb2dc57e",
  cc: {
    ok: true,
    uuid: "test-uuid",
    encrypted:
      "U2FsdGVkX1/erb7vyv66vpkuYEDix2t+du6wIuNk5CQSFFmuaxkRMUyrPrhFhAWCyGFnd6WKpFtzYX6tHkFEwK8egrWjsNYQ+hNM6QynxVvyWGMbPFKmB/UJwZjBS/3BxDkFZ+q8TbkSYrI0nAMgy4j/3TSKn9th8b44xNKeRSeCJq7iiLON0qa7c7fXcCN5qzhYyB0k2HuSlQKU4825JNWNNz8CxK0KUx7PRCfnYBjGY8e/IIc3elck54oXqVs3WCcbvKQsEjqCjr5fm/TBkvFGMPq+Gp828AAQKC9iaGnxkn56s1YaSSCjm4FFNzRyg5SPrutbmn4ENOUZm2LxYAf9O/z5qyka7/FhHG+qtHE4sMhb9TqKpa6cqYBBM+0A9LmeSW2YRHXXPXRLYX2c5whUbSoWLa47jrIA0LIfQSPqRkS1lH0Xiu4OX2jM7Zu2Km2/kiNtwDn5+2dfLJkIkubP6EV8Krb1wr8muDwGoH59Jc5HRqkoAI/ddiiLjIzznmvSdGLIviB/C03FQ1r+17sKGqYdCBGDMUA3d3+RAaaRzoGlk/L+vSVgLqIq3tVhIblJjX8cO46XYSTWEcetLP25labl8uaslc7k2EQy82qhVhMcJTXOW55F+Gn5mkJc",
    plaintext:
      '{"cookie_data":{"mteam.example":[{"name":"sid","value":"secret"}]},"local_storage_data":{},"ptd_data":{"config":{"lang":"zh_CN"},"metadata":{"sites":{"mteam":{"url":"https://mteam.example"}}}},"manifest":{"time":1760000000000,"version":"test","files":{},"encryption":true,"fileName":"PTD_backup_20261004T0215.zip","path":"","size":"N/A"},"integritySalt":"wMHCw8TFxsfIycrLzM3Ozw==","integrity":"3c0753645a395d8eddd39cb918b80c0a94aa1582573377dea7b449434c1b060a"}',
  },
  ccDelete:
    "U2FsdGVkX1+Id2ZVRDMiEX/89ZKGjdAAQXHAwODpcL+NHSg3XuUg7Bbn3HgMcWFioX8+rKmoIVzm3KiSTrARdiv5Lu+SX8M+AaZxXvdpBlqzaoxaU6S92SpHzAF5Vkf1xsQZ9aDWkgBULj0e//FWn9h/4luRfLtg3nJ32NJjeN0JUIx97kNscrkduYlo7mAHHzVBeIs7Lj2t96R1Chrzt4tfmzJlrnBKZn3sCpqsdyKL7OG4Tl9ZsrVoBZdd7jIsyGcAMQQ6bIPLtmeHsIHni75oXsM1CP2J52bbhmYTdQbG1JLiPrusPCY3q1W3IhpHGrXozwtCe4D5iYcL8uxGz4Z0l2q/1FqwYQB+iWnjU3tGobm7eZnFF6EWPCrxMr03VskMqNk8tzbLq34EVMweDA==",
  ccRead: {
    ok: {
      config: {
        lang: "zh_CN",
      },
      metadata: {
        sites: {
          mteam: {
            url: "https://mteam.example",
          },
        },
      },
      cookies: {
        "mteam.example": [
          {
            name: "sid",
            value: "secret",
          },
        ],
      },
      manifest: {
        time: 1760000000000,
        version: "test",
        files: {
          config: true,
          metadata: true,
          cookies: true,
        },
        encryption: true,
        fileName: "PTD_backup_20261004T0215.zip",
        path: "",
        size: "N/A",
      },
    },
  },
  ccWrongPw: {
    name: "Error",
    message: "Malformed UTF-8 data",
  },
  ccTampered:
    "U2FsdGVkX18KCwwNDg8QEYImtD0x1NSwsigvQhNJeEst+3XX86gTtoKq7JemaqoMTlQ2CNZ/UNKDCB97YeIXAGWJuJ1c6HAF3+9zn6BuA2g/Fxdq4tpgov/4cLOoV/GF0enFCzguTCAv1YJ0A3Nm2J/sLVbDnoBQmXI6cXK/mSsOoXgup7NOEVrXf8pKkThlZP1YlApGoEk6AZPTklwA5Pb8LGocI6NjBsLu7xi8R81FoBKJqe92ll0SxMzAB5Pr+gqRKAsRfxfj3ctCcB6a1Zn5tRVGIK5amMrX1vwZMPRvoaOE9kAw/DX9nhIqGirbOBdtXWehc3nUYLOJn0hk6fNyHv3vjUClJFIW4I/n6D+RBcRSJ8KOy6lk7BGOJh54xzj0Pa3raUiNs7gASZLd8YZVmt5nEVNO0ydpzi0z+8Y2rsc1vZO+jmF8xcgOImu2OLuw19w1+hWwHKtAbZ21QViNq1jnsrGrr9pFzvHCEZZUiiBSX6e0C6EYea6X8kdR46L/8zXwIHxvFWyBEaQ7ZLnzoEp9Vb/KbehqeA+X1oWpWZ3uYCllMhd+y5HduntQlfKLXjUGUBoZPlC+KO15MfJgfDdE6SoSIjGNutcU0xvgXF8OA8vyGYzJUokjD/PU",
  ccTamperedRead: {
    name: "Error",
    message: "CookieCloud backup integrity check failed",
  },
  ccLegacy:
    "U2FsdGVkX18RIjNEVWZ3iOhhvfWKvDrEEjCjUxMYTSVNQo7U2EOJtOz+qisd526dypH6jjo8EQFK19Zse+GxVqBbeStMZWL+TYwy1x1sCC5shlpcyzjTUIhCu1lSP89bfZHjF7iSOygU5y+E3VGY6vfRkl6+yf/SFzCqvoR0b+Napk/Cz3SL8V5jZJQZtdbe+puUOhXj8P0or2DSusS3q3uBah206L6NR17Wxh6EKvy7kylBM8Qlqp9vAfNQGwQ9ZkCvZbmwt1Yyhg2wZ5bYSIOkXBIn+4IKjbb2XNTFqzxnPY5j0CYmN4lP3XuRBAYo",
  ccLegacyRead: {
    ok: {
      config: {
        lang: "en",
      },
      cookies: {
        "a.example": [
          {
            name: "c",
            value: "v",
          },
        ],
      },
      manifest: {
        encryption: true,
        fileName: "old.zip",
        path: "",
        time: 5,
        size: "N/A",
        files: {
          config: true,
          cookies: true,
        },
      },
    },
  },
  inputs: {
    PASSWORD: "p@ss wörd-密码-🔑",
    SALT1: "8f1e2d3c4b5a69788796a5b4c3d2e1f0",
    IV1: "0123456789abcdeffedcba9876543210",
    SALT2: "00112233445566778899aabbccddeeff",
    IV2: "ffeeddccbbaa99887766554433221100",
    BACKUP_SALT: "5f4dcc3b5aa765d61d8327deb882cf99",
    IV_CONFIG: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    IV_USERINFO: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
    OSSL_SALT1: "1122334455667788",
    OSSL_SALT2: "8877665544332211",
    OSSL_SALT3: "0a0b0c0d0e0f1011",
    OSSL_SALT4: "deadbeefcafebabe",
    CC_INTEGRITY_SALT: "c0c1c2c3c4c5c6c7c8c9cacbcccdcecf",
    CC_INTEGRITY_SALT2: "d0d1d2d3d4d5d6d7d8d9dadbdcdddedf",
    KEY32: "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4",
    KEY16: "2b7e151628aed2a6abf7158809cf4f3c",
    FIXED_NOW: 1760000000000,
    DATA: {
      lang: "zh_CN",
      note: "备份 🚀",
      nested: {
        list: [1, 2, 3],
        flag: true,
      },
    },
    HASH_INPUTS: [
      "",
      "abc",
      "PTD-depiler 备份 🚀",
      '{"lang":"zh_CN"}',
      "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ],
  },
};
