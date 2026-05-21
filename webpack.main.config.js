const path = require('path');
const webpack = require('webpack');

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
  plugins: [
    new webpack.DefinePlugin({
      'process.env.ARETICA_ANTHROPIC_KEY':    JSON.stringify(process.env.ARETICA_ANTHROPIC_KEY    || ''),
      'process.env.ARETICA_ELEVENLABS_KEY':   JSON.stringify(process.env.ARETICA_ELEVENLABS_KEY   || ''),
      'process.env.ARETICA_ELEVENLABS_VOICE_ID': JSON.stringify(process.env.ARETICA_ELEVENLABS_VOICE_ID || ''),
      'process.env.ARETICA_SUPABASE_URL':     JSON.stringify(process.env.ARETICA_SUPABASE_URL     || ''),
      'process.env.ARETICA_SUPABASE_ANON_KEY': JSON.stringify(process.env.ARETICA_SUPABASE_ANON_KEY || ''),
    }),
  ],
};
