const path = require('path');

module.exports = {
  entry: './src/main.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [{ loader: 'ts-loader' }],
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  target: 'electron-main',
  externals: {
    // All dependencies are Node built-ins (child_process, fs, path, os)
    // or pure-JS npm packages — no native externals needed
  },
};
