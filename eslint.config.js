/**
 * ESLint flat config for DING (GJS codebase).
 *
 * - Root .js files (extension.js, prefs.js, visibleArea.js, ...) are ESM
 *   modules running inside GNOME Shell.
 * - app/*.js files are legacy `imports.gi` scripts running under plain gjs.
 * - The custom `exported-comments` rule marks `var X` symbols that carry a
 *   `/* exported X *​/` GJS comment as "used", so no-unused-vars accepts them.
 */
'use strict';

const GJS_GLOBALS = {
    // GJS runtime globals (legacy modules + shell)
    imports: 'readonly',
    print: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    global: 'readonly',
    window: 'readonly',
    ByteArray: 'readonly',
    console: 'readonly',
    ARGV: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
};

// In legacy GJS modules every top-level `var` / `function` declaration is an
// implicit export (that's how `imports.foo.Bar` resolves). Mark them as used
// so no-unused-vars accepts them, while still honouring explicit
// `/* exported Name */` comments (module-scope class/const exports).
const exportedCommentsRule = {
    meta: {
        type: 'problem',
        docs: { description: 'Mark GJS `/* exported Name */` symbols and legacy top-level exports as used' },
        schema: [],
    },
    create(context) {
        return {
            'Program:exit'(node) {
                const sourceCode = context.sourceCode;
                const comments = sourceCode.getAllComments();
                const scope = sourceCode.getScope(node);
                for (const comment of comments) {
                    const match = /^\s*exported\s+([A-Za-z_$][\w$]*)/.exec(comment.value);
                    if (!match)
                        continue;
                    const variable = scope.set.get(match[1]);
                    if (variable)
                        variable.eslintUsed = true;
                }
                // Legacy GJS: top-level `var X` / `function X` are implicit
                // exports (resolved via `imports.module.X`).
                if (context.languageOptions.sourceType !== 'script')
                    return;
                for (const variable of scope.set.values()) {
                    const isTopLevel = variable.defs.some(d => {
                        if (d.type === 'Variable')
                            return d.node.parent.kind === 'var' &&
                                d.node.parent.parent === node;
                        if (d.type === 'FunctionName')
                            return d.node.parent === node;
                        return false;
                    });
                    if (isTopLevel)
                        variable.eslintUsed = true;
                }
            },
        };
    },
};

export default [
    {
        ignores: [
            'node_modules/**',
            '.build/**',
            'builddir/**',
            '.git/**',
            '.pi/**',
            '.opencode/**',
            '.codegraph/**',
            'po/**',
            'schemas/**',
            'eslint.config.js',
        ],
    },
    {
        plugins: {
            local: { rules: { 'exported-comments': exportedCommentsRule } },
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: GJS_GLOBALS,
        },
        rules: {
            'local/exported-comments': 'error',
            'no-unused-vars': ['error', {
                args: 'none',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],
            'no-undef': 'error',
            'no-unused-expressions': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-unreachable': 'error',
            'no-extra-semi': 'error',
        },
    },
    {
        files: ['extension.js', 'prefs.js', 'visible-area.js',
            'emulate-x11-window-type.js', 'gnome-shell-override.js'],
        languageOptions: {
            sourceType: 'module',
        },
    },
];
