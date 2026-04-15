const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  // 'source-map' externalises source maps to .map files instead of using
  // eval(), so the renderer runs cleanly under a strict Content-Security-Policy.
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [{ loader: 'ts-loader' }],
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  target: 'web',
};
