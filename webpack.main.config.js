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
    // Playwright ships binary assets (PNG, CSS, fonts) that webpack can't bundle.
    // Mark it external so Node.js requires it at runtime from node_modules.
    playwright: 'commonjs playwright',
    'playwright-core': 'commonjs playwright-core',
  },
};
