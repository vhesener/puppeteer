/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const os = require('os');
const path = require('path');
const removeFolder = require('rimraf');
const childProcess = require('child_process');
const Downloader = require('../utils/ChromiumDownloader');
const {Connection} = require('./Connection');
const {Browser} = require('./Browser');
const readline = require('readline');
const fs = require('fs');
const {helper} = require('./helper');
const EventEmitter = require('events');
// @ts-ignore
const ChromiumRevision = require('../package.json').puppeteer.chromium_revision;

const mkdtempAsync = helper.promisify(fs.mkdtemp);
const removeFolderAsync = helper.promisify(removeFolder);

const CHROME_PROFILE_PATH = path.join(os.tmpdir(), 'puppeteer_dev_profile-');

const DEFAULT_ARGS = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--no-first-run',
  '--remote-debugging-port=0',
  '--safebrowsing-disable-auto-update',
];

const AUTOMATION_ARGS = [
  '--enable-automation',
  '--password-store=basic',
  '--use-mock-keychain',
];

class Launcher {
  /**
   * @param {!Object=} options
   * @return {!Promise<!Browser>}
   */
  static async launch(options) {
    options = Object.assign({}, options || {});
    let temporaryUserDataDir = null;
    const chromeArguments = [].concat(DEFAULT_ARGS);
    if (options.appMode)
      options.headless = false;
    else
      chromeArguments.push(...AUTOMATION_ARGS);

    if (!options.args || !options.args.some(arg => arg.startsWith('--user-data-dir'))) {
      if (!options.userDataDir)
        temporaryUserDataDir = await mkdtempAsync(CHROME_PROFILE_PATH);

      chromeArguments.push(`--user-data-dir=${options.userDataDir || temporaryUserDataDir}`);
    }
    if (options.devtools === true) {
      chromeArguments.push('--auto-open-devtools-for-tabs');
      options.headless = false;
    }
    if (typeof options.headless !== 'boolean' || options.headless) {
      chromeArguments.push(
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--mute-audio'
      );
    }
    let chromeExecutable = options.executablePath;
    if (typeof chromeExecutable !== 'string') {
      const revisionInfo = Downloader.revisionInfo(Downloader.currentPlatform(), ChromiumRevision);
      console.assert(revisionInfo.downloaded, `Chromium revision is not downloaded. Run "npm install"`);
      chromeExecutable = revisionInfo.executablePath;
    }
    if (Array.isArray(options.args))
      chromeArguments.push(...options.args);

    const chromeProcess = childProcess.spawn(
        chromeExecutable,
        chromeArguments,
        {
          detached: true,
          env: options.env || process.env
        }
    );
    if (options.dumpio) {
      chromeProcess.stdout.pipe(process.stdout);
      chromeProcess.stderr.pipe(process.stderr);
    }

    let chromeClosed = false;
    const waitForChromeToClose = new Promise((fulfill, reject) => {
      chromeProcess.once('close', () => {
        chromeClosed = true;
        // Cleanup as processes exit.
        if (temporaryUserDataDir) {
          removeFolderAsync(temporaryUserDataDir)
              .then(() => fulfill())
              .catch(err => console.error(err));
        } else {
          fulfill();
        }
      });
    });

    const listeners = [ helper.addEventListener(exitEmitter, 'exit', forceKillChrome) ];
    if (options.handleSIGINT !== false)
      listeners.push(helper.addEventListener(exitEmitter, 'SIGINT', forceKillChrome));
    if (options.handleSIGTERM !== false)
      listeners.push(helper.addEventListener(exitEmitter, 'SIGTERM', killChrome));
    if (options.handleSIGHUP !== false)
      listeners.push(helper.addEventListener(exitEmitter, 'SIGHUP', killChrome));
    /** @type {?Connection} */
    let connection = null;
    try {
      const connectionDelay = options.slowMo || 0;
      const browserWSEndpoint = await waitForWSEndpoint(chromeProcess, options.timeout || 30 * 1000);
      connection = await Connection.create(browserWSEndpoint, connectionDelay);
      return Browser.create(connection, options, killChrome);
    } catch (e) {
      forceKillChrome();
      throw e;
    }

    /**
     * @return {Promise}
     */
    function killChrome() {
      helper.removeEventListeners(listeners);
      if (temporaryUserDataDir) {
        forceKillChrome();
      } else if (connection) {
        // Attempt to close chrome gracefully
        connection.send('Browser.close');
      }
      return waitForChromeToClose;
    }

    function forceKillChrome() {
      helper.removeEventListeners(listeners);
      if (chromeProcess.pid && !chromeProcess.killed && !chromeClosed) {
        // Force kill chrome.
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${chromeProcess.pid} /T /F`);
        else
          process.kill(-chromeProcess.pid, 'SIGKILL');
      }
      // Attempt to remove temporary profile directory to avoid littering.
      try {
        removeFolder.sync(temporaryUserDataDir);
      } catch (e) { }
    }
  }

  /**
   * @return {string}
   */
  static executablePath() {
    const revisionInfo = Downloader.revisionInfo(Downloader.currentPlatform(), ChromiumRevision);
    return revisionInfo.executablePath;
  }

  /**
   * @param {!Object=} options
   * @return {!Promise<!Browser>}
   */
  static async connect(options = {}) {
    const connection = await Connection.create(options.browserWSEndpoint);
    return Browser.create(connection, options, () => connection.send('Browser.close'));
  }
}

class ExitEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(Infinity);
    const processListeners = [ helper.addEventListener(process, 'exit', exitHandler.bind(this)) ];
    processListeners.push(helper.addEventListener(process, 'SIGINT', sigHandler('SIGINT', 2).bind(this)));
    processListeners.push(helper.addEventListener(process, 'SIGTERM', sigHandler('SIGTERM', 15).bind(this)));
    processListeners.push(helper.addEventListener(process, 'SIGHUP', sigHandler('SIGHUP', 1).bind(this)));

    function sigHandler(eventName, exitCode) {
      return function() {
        helper.removeEventListeners(processListeners);
        this.emit(eventName);
        process.exit(exitCode);
      };
    }

    function exitHandler(exitCode) {
      helper.removeEventListeners(processListeners);
      this.emit('exit', exitCode);
    }
  }
}
const exitEmitter = new ExitEmitter();

/**
 * @param {!Puppeteer.ChildProcess} chromeProcess
 * @param {number} timeout
 * @return {!Promise<string>}
 */
function waitForWSEndpoint(chromeProcess, timeout) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: chromeProcess.stderr });
    let stderr = '';
    const listeners = [
      helper.addEventListener(rl, 'line', onLine),
      helper.addEventListener(rl, 'close', () => onClose()),
      helper.addEventListener(chromeProcess, 'exit', () => onClose()),
      helper.addEventListener(chromeProcess, 'error', error => onClose(error))
    ];
    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

    /**
     * @param {!Error=} error
     */
    function onClose(error) {
      cleanup();
      reject(new Error([
        'Failed to launch chrome!' + (error ? ' ' + error.message : ''),
        stderr,
        '',
        'TROUBLESHOOTING: https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md',
        '',
      ].join('\n')));
    }

    function onTimeout() {
      cleanup();
      reject(new Error(`Timed out after ${timeout} ms while trying to connect to Chrome! The only Chrome revision guaranteed to work is r${ChromiumRevision}`));
    }

    /**
     * @param {string} line
     */
    function onLine(line) {
      stderr += line + '\n';
      const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
      if (!match)
        return;
      cleanup();
      resolve(match[1]);
    }

    function cleanup() {
      if (timeoutId)
        clearTimeout(timeoutId);
      helper.removeEventListeners(listeners);
    }
  });
}

module.exports = Launcher;
