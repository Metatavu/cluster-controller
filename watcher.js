/*jshint esversion: 6 */
(function() {
'use strict';

  const config = require("nconf");
  const events = require('events');
  const util = require('util');
  const request = require('request');
  const _ = require('lodash');
  const statusUtils = require('./statusUtils');

  class Watcher extends events.EventEmitter {

    constructor() {
      super();
      this.hosts = config.get("hosts");
      this.manuallyDown = [];
      this.onGroupUp = {};
      this.checkPath = config.get("checkPath");
      this.statusPath = config.get("statusPath");
      this.interval = config.get("checkInterval") || 1000;
      this.timeout = config.get("timeout") || 10000;
      this.lastHostTimeout = config.get("lastHostTimeout") || 60000;
      this.waitAfterUp = config.get("waitAfterUp") || 10000;
      this.index = 0;
    }

    start() {
      this.checkHost();
    }

    setUp(host) {
      _.remove(this.manuallyDown, (url) => { return url == host.url; });
    }

    setDown(host) {
      this.manuallyDown.push(host.url);
      this.handleHostDown(host);
    }

    waitUntilUp(group, callback) {
      if(!this.onGroupUp[group]) {
        this.onGroupUp[group] = [callback];
      } else {
        this.onGroupUp[group].push(callback)
      }
    }

    clearUpCallbacks(group) {
      this.onGroupUp[group] = [];
    }

    handleHostUp(host) {
      var status = statusUtils.loadStatus(this.statusPath);
      if (status.hosts[host.url] == 'DOWN') {
        status.hosts[host.url] = 'UP';
        var groupUp = this.checkGroup(host.group, status);
        if (groupUp) {
          status.groups[host.group] = 'UP'
        }
        statusUtils.saveStatus(this.statusPath, status);
        
        setTimeout(() => {
          this.emit('host-up', host);
          if (groupUp) {
            this.emit('group-up', host.group);
          }
        }, this.waitAfterUp);
      }
    }

    handleHostDown(host) {
      var status = statusUtils.loadStatus(this.statusPath);
      if (status.hosts[host.url] == 'UP') {
        status.hosts[host.url] = 'DOWN';
        var groupUp = status.groups[host.group] == 'UP';
        status.groups[host.group] = 'DOWN';
        statusUtils.saveStatus(this.statusPath, status);
        this.emit('host-down', host);
        if (groupUp) {
          this.emit('group-down', host.group);
        }
      }
    }

    checkHost() {
      this.index = this.index % this.hosts.length;
      var host = this.hosts[this.index];
      var options = {
        url: util.format('%s://%s%s', host.protocol, host.url, this.checkPath),
        headers: host.headers,
        timeout: this.isLastHostUp(host) ? this.lastHostTimeout : this.timeout
      };
      if (this.manuallyDown.indexOf(host.url) > -1) {
        this.handleHostDown(host);
        this.index++;
        setTimeout(() => this.checkHost(), this.interval)
      } else {
        request(options, (error, response, body) => {
          if (!error && response.statusCode < 300 && response.statusCode >= 200) {
            this.handleHostUp(host);
          } else {
            this.handleHostDown(host);
          }
          this.index++;
          setTimeout(() => this.checkHost(), this.interval);
        });
      }

      this.updateGroups();
    }

    /**
     * Checks if host is the last one up in cluster
     * 
     * @param {Object} host host object
     * @returns {Boolean} returns true if the host is last one up in the cluster, false otherwise
     */
    isLastHostUp(host) {
      const status = statusUtils.loadStatus(this.statusPath);
      if (status.hosts[host.url] === 'DOWN') {
        return false;
      }
 
      for (let i = 0; i < this.hosts.length; i++) {
        let anotherHost = this.hosts[i];
        if (host.url !== anotherHost.url && status.hosts[anotherHost.url] === 'UP') {
          return false;
        }
      }
      
      return true;
    }

    updateGroups() {
      var status = statusUtils.loadStatus(this.statusPath);
      for (let i = 0; i < this.hosts.length; i++) {
        let host = this.hosts[i];
        if (status.groups[host.group] == 'UP') {
          setTimeout(() => {
            this.runUpCallbacks(host.group);
          }, this.waitAfterUp);
        }
      }
    }

    runUpCallbacks(group) {
      if(this.onGroupUp[group]) {
        for(let i = 0; i < this.onGroupUp[group].length; i++) {
          this.onGroupUp[group][i]();
        }
        this.onGroupUp[group] = [];
      }
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
