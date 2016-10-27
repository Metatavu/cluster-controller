"use strict";

(function() {

  var events = require('events');
  var util = require('util');
  var request = require('request');
  var statusUtils = require('./statusUtils');

  class Watcher extends events.EventEmitter {
    constructor(config) {
      super();
      this.hosts = config.hosts;
      this.checkPath = config.checkPath;
      this.statusPath = config.statusPath;
      this.index = 0;
    }
    start() {
      this.checkHost();
    }
    checkHost() {
      this.index = this.index % this.hosts.length;
      var host = this.hosts[this.index];
      request(util.format('%s%s', host.url, this.checkPath), (error, response, body) => {
        var status = statusUtils.loadStatus(this.statusPath);
        if (!error && response.statusCode < 300 && response.statusCode >= 200) {
          if (status.hosts[host.url] == 'DOWN') {
            status.hosts[host.url] = 'UP';
            this.emit('host-up', host);
            if (this.checkGroup(host.group, status)) {
              this.emit('group-up', host.group);
            }
            statusUtils.saveStatus(this.statusPath, status);
          }
        } else {
          if (status.hosts[host.url] == 'UP') {
            status.hosts[host.url] = 'DOWN';
            if(status.groups[host.group] == 'UP') {
              status.groups[host.group] = 'DOWN';
              this.emit('group-down', host.group);
            }
            this.emit('host-down', host);
            statusUtils.saveStatus(this.statusPath, status);
          }
        }
        this.index++;
        setTimeout(() => this.checkHost, 500);
      });
    }
    checkGroup(group, status) {
      for (var i = 0; i < this.hosts.length; i++) {
        var host = this.hosts[i];
        if (host.group == group && status.hosts[host.url] == 'DOWN') {
          return false;
        }
      }
      return true;
    }
  }

module.exports = Watcher;
  
})();
