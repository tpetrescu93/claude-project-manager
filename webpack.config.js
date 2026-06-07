/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the GPLv3 License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const fs = require('fs');
const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

// Copies src/scripts/ → dist/scripts/ after every build
class CopyScriptsPlugin {
    apply(compiler) {
        compiler.hooks.afterEmit.tap('CopyScriptsPlugin', () => {
            const src = path.resolve(__dirname, 'src/scripts');
            const dst = path.resolve(__dirname, 'dist/scripts');
            if (fs.existsSync(src)) {
                fs.mkdirSync(dst, { recursive: true });
                for (const f of fs.readdirSync(src)) {
                    fs.copyFileSync(path.join(src, f), path.join(dst, f));
                    fs.chmodSync(path.join(dst, f), 0o755);
                }
            }
        });
    }
}

/**@type {import('webpack').Configuration}*/
const config = {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/

    entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: { // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    optimization: {
        minimizer: [new TerserPlugin({
            parallel: true,
            extractComments: false,
            terserOptions: {
                ecma: 2020,
                keep_classnames: false,
                mangle: true,
                module: true,
                format: {
                    comments: false
                }
            }
        })],
    },
    
    devtool: 'source-map',
    externals: {
        vscode: "commonjs vscode" // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
    resolve: { // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader',
            }]
        }]
    },
    plugins: [new CopyScriptsPlugin()],
}

module.exports = config;
