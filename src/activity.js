const { EventEmitter } = require('events');
const { uIOhook } = require('uiohook-napi');

// Raw global input events, emitted regardless of app state.
// main.js decides whether to actually count them (only while a session
// is active), so this module stays a dumb event source.
const emitter = new EventEmitter();
let started = false;

function startActivityTracking() {
  if (started) return;
  uIOhook.on('click', () => emitter.emit('click'));
  uIOhook.on('keydown', () => emitter.emit('keydown'));
  uIOhook.start();
  started = true;
}

function stopActivityTracking() {
  if (!started) return;
  uIOhook.stop();
  started = false;
}

module.exports = { startActivityTracking, stopActivityTracking, emitter };