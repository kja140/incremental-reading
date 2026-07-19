// @ts-check
const config = {
  title: 'Incremental Reading Toolkit',
  tagline: 'Turn long reading into small sessions and durable knowledge',
  favicon: 'img/favicon.svg',
  url: 'https://incremental-reading.kjames.xyz',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',
  organizationName: 'kja140',
  projectName: 'incremental-reading',
  presets: [[
    'classic',
    {
      docs: {sidebarPath: require.resolve('./sidebars.js'), routeBasePath: 'docs'},
      blog: false,
      theme: {customCss: require.resolve('./src/css/custom.css')},
    },
  ]],
  themeConfig: {
    colorMode: {defaultMode: 'dark', respectPrefersColorScheme: true},
    announcementBar: {
      id: 'release_1_1_7',
      content: '⚡ <strong>Version 1.1.7:</strong> much faster note switching and grading—the crash-prone refresh path is gone. <a href="/docs/releases/1.1.7">What’s new →</a>',
      backgroundColor: '#7aa2f7',
      textColor: '#1a1b26',
      isCloseable: true,
    },
    navbar: {
      title: 'IR Toolkit',
      logo: {alt: 'Incremental Reading Toolkit mark', src: 'img/favicon.svg'},
      items: [
        {to: '/docs/getting-started/what-is-incremental-reading', label: 'Learn', position: 'left'},
        {to: '/docs/workflows/your-first-session', label: 'Workflows', position: 'left'},
        {to: '/docs/reference/commands', label: 'Reference', position: 'left'},
        {to: '/docs/releases/1.1.7', label: 'What’s new', position: 'right'},
        {href: 'https://github.com/kja140/incremental-reading', label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {title: 'Start', items: [{label: 'What is incremental reading?', to: '/docs/getting-started/what-is-incremental-reading'}, {label: 'Install', to: '/docs/getting-started/installation'}]},
        {title: 'Use the toolkit', items: [{label: 'First session', to: '/docs/workflows/your-first-session'}, {label: 'Commands', to: '/docs/reference/commands'}]},
        {title: 'Project', items: [{label: 'GitHub', href: 'https://github.com/kja140/incremental-reading'}, {label: 'Privacy', to: '/docs/reference/privacy'}]},
      ],
      copyright: `Incremental Reading Toolkit · MIT licensed · ${new Date().getFullYear()}`,
    },
    prism: {additionalLanguages: ['yaml']},
  },
};

module.exports = config;
