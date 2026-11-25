module.exports = {
  preset: '@metamask/snaps-jest',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.m?js$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
  },
  // Some @metamask and @noble packages ship ESM only. Let Jest transform them.
  transformIgnorePatterns: ['/node_modules/(?!(@metamask|@noble|@scure|@ethereumjs|uuid|nanoid|lodash-es)/)'],
  moduleNameMapper: { '^lodash-es$': 'lodash' },
  testTimeout: 60000,
};
