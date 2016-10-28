var fs = require('fs');

exports.loadStatus = function(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

exports.saveStatus = function(path, status) {
  fs.writeFileSync(path, JSON.stringify(status));
}