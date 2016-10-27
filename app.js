var express = require('express');
var http = require('http');
var app = express();
var config = require('./config');

app.set('port', config.port);

app.get('/', function(req, res) {

});