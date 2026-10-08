// The unit config without the in-process guard: used only to prove the container network boundary stops a request by itself.
const { setupFilesAfterEnv, ...config } = require('./jest.config');
module.exports = config;
