const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    name: 'Axon',
    executableName: 'Axon',
    appBundleId: 'ai.aretica.axon',
    appCategoryType: 'public.app-category.productivity',
    icon: './src/assets/Axon',
    appVersion: '1.0.0',
    appCopyright: 'Copyright © 2026 Aretica',
    osxSign: false,
    asar: { unpack: '**/*.node' },
    arch: 'universal',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Axon needs microphone access to listen for your voice.',
      NSCalendarsUsageDescription:  'Axon needs calendar access to give you daily briefings and event reminders.',
    },
    ignore: [
      /node_modules\/\.cache/,
      /\.git/,
      /training_data/,
      /axon-model/,
      /scripts\/fine_tune/,
      /\.env$/,
      /\.env\..*/,
      /^\/out\//,
      /\.webpack\/renderer\/.*\.map$/,
    ]
  },
  hooks: {
    prePackage: async () => {
      const { execSync } = require('child_process');
      // Pass parent process.env explicitly so child inherits all keys (including ARETICA_*)
      execSync('node scripts/inject-env.js', { stdio: 'inherit', env: process.env });

      const fs = require('fs');
      const content = fs.readFileSync('./src/buildConstants.ts', 'utf8');
      if (content.includes("ARETICA_ANTHROPIC_KEY: ''")) {
        console.warn('[forge] WARNING: buildConstants has empty ANTHROPIC key — check your .env');
      } else {
        console.log('[forge] buildConstants verified — keys present');
      }
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Axon',
        title: 'Axon by Aretica',
        background: './src/assets/dmg-background.png',
        icon: './src/assets/Axon.icns',
        iconSize: 80,
        window: {
          size: { width: 660, height: 400 },
        },
        contents: (opts) => [
          { x: 180, y: 220, type: 'file', path: opts.appPath },
          { x: 480, y: 220, type: 'link', path: '/Applications' },
        ],
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    }
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'IsaacStallan',
          name:  'Axon-desktop'
        },
        prerelease: true,
        draft: false,
        generateReleaseNotes: false,
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/orb/orb.html',
              js: './src/orb/orb.ts',
              name: 'orb_window',
              preload: {
                js: './src/preload.ts',
              },
            },
            {
              html: './src/onboarding/onboarding.html',
              js: './src/onboarding/onboarding.ts',
              name: 'onboarding_window',
              preload: {
                js: './src/onboarding/onboarding-preload.ts',
              },
            },
            {
              html: './src/softlock/softlock.html',
              js: './src/softlock/softlock.ts',
              name: 'softlock_window',
              preload: {
                js: './src/softlock/softlock-preload.ts',
              },
            },
          ],
        },
      },
    },
  ],
};
