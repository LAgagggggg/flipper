/**
 * Copyright 2018-present Facebook.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @format
 */

import BaseDevice, {DeviceType, LogLevel} from './BaseDevice';
import adb, {Client as ADBClient} from 'adbkit';
import {Priority} from 'adbkit-logcat';
import ArchivedDevice from './ArchivedDevice';
import {createWriteStream} from 'fs';

const DEVICE_RECORDING_DIR = '/sdcard/flipper_recorder';

export default class AndroidDevice extends BaseDevice {
  constructor(
    serial: string,
    deviceType: DeviceType,
    title: string,
    adb: ADBClient,
  ) {
    super(serial, deviceType, title, 'Android');
    this.adb = adb;
    this.icon = 'icons/android.svg';
    this.adb.openLogcat(this.serial).then(reader => {
      reader.on('entry', entry => {
        let type: LogLevel = 'unknown';
        if (entry.priority === Priority.VERBOSE) {
          type = 'verbose';
        }
        if (entry.priority === Priority.DEBUG) {
          type = 'debug';
        }
        if (entry.priority === Priority.INFO) {
          type = 'info';
        }
        if (entry.priority === Priority.WARN) {
          type = 'warn';
        }
        if (entry.priority === Priority.ERROR) {
          type = 'error';
        }
        if (entry.priority === Priority.FATAL) {
          type = 'fatal';
        }

        this.addLogEntry({
          tag: entry.tag,
          pid: entry.pid,
          tid: entry.tid,
          message: entry.message,
          date: entry.date,
          type,
        });
      });
    });
  }

  adb: ADBClient;
  pidAppMapping: {[key: number]: string} = {};
  private recordingDestination?: string;

  supportedColumns(): Array<string> {
    return ['date', 'pid', 'tid', 'tag', 'message', 'type', 'time'];
  }

  reverse(ports: [number, number]): Promise<void> {
    return Promise.all(
      ports.map(port =>
        this.adb.reverse(this.serial, `tcp:${port}`, `tcp:${port}`),
      ),
    ).then(() => {
      return;
    });
  }

  clearLogs(): Promise<void> {
    this.logEntries = [];
    return this.executeShell(['logcat', '-c']);
  }

  archive(): ArchivedDevice {
    return new ArchivedDevice(
      this.serial,
      this.deviceType,
      this.title,
      this.os,
      [...this.logEntries],
    );
  }

  navigateToLocation(location: string) {
    const shellCommand = `am start ${encodeURI(location)}`;
    this.adb.shell(this.serial, shellCommand);
  }

  screenshot(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.adb.screencap(this.serial).then(stream => {
        const chunks: Array<Buffer> = [];
        stream
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .once('end', () => {
            resolve(Buffer.concat(chunks));
          })
          .once('error', reject);
      });
    });
  }

  async screenCaptureAvailable(): Promise<boolean> {
    try {
      await this.executeShell(
        `[ ! -f /system/bin/screenrecord ] && echo "File does not exist"`,
      );
      return true;
    } catch (_e) {
      return false;
    }
  }

  private async executeShell(command: string | string[]): Promise<void> {
    const output = await this.adb
      .shell(this.serial, command)
      .then(adb.util.readAll)
      .then((output: Buffer) => output.toString().trim());
    if (output) {
      throw new Error(output);
    }
  }

  async startScreenCapture(destination: string) {
    await this.executeShell(
      `mkdir -p "${DEVICE_RECORDING_DIR}" && echo -n > "${DEVICE_RECORDING_DIR}/.nomedia"`,
    );
    this.recordingDestination = destination;
    const recordingLocation = `${DEVICE_RECORDING_DIR}/video.mp4`;
    this.adb
      .shell(this.serial, `screenrecord --bugreport "${recordingLocation}"`)
      .then(
        () =>
          new Promise((resolve, reject) =>
            this.adb.pull(this.serial, recordingLocation).then(stream => {
              stream.on('end', resolve);
              stream.on('error', reject);
              stream.pipe(createWriteStream(destination));
            }),
          ),
      );
  }

  async stopScreenCapture(): Promise<string> {
    const {recordingDestination} = this;
    if (!recordingDestination) {
      return Promise.reject(new Error('Recording was not properly started'));
    }
    this.recordingDestination = undefined;
    await this.adb.shell(this.serial, `pgrep 'screenrecord' -L 2`);
    return recordingDestination;
  }
}
