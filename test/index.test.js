'use strict';
/* jshint -W079 */
/* global describe, it, beforeEach, afterEach */
var http = require('http');
var $ = require('jquery');
var Promise = require('bluebird');
var _ = require('lodash');
var ajaxLimited = require('..');
var chai = require('chai');
var najax = require('najax');

chai.should();
$.ajax = najax; // For testing on Node.js

var DEFAULT_OPTIONS = {
  bucketSize: 9,
  tokensPerInterval: 9,
  interval: 3000,
};

var AjaxLimited = ajaxLimited.AjaxLimited;

describe('AjaxLimited', function() {
  beforeEach(function() {
    this.ajaxLimited = new AjaxLimited();
  });

  afterEach(function() {
    this.ajaxLimited.restore();
  });

  describe('.prototype._getBucketFor(url, settings)', function() {
    it('returns the global bucket when there\'re no childs', function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);
      this.ajaxLimited._getBucketFor(['/', {}])
        .should.eql(this.ajaxLimited.bucket);
    });

    it('returns child buckets if they match the request', function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);

      this.ajaxLimited.get(_.defaults({
        bucketSize: 3
      }, DEFAULT_OPTIONS));

      var bucket = this.ajaxLimited._getBucketFor([{
        type: 'GET',
        url: 'https://localhost:3000',
      }]);

      bucket.should.not.eql(this.ajaxLimited.bucket);
      bucket.parentBucket.should.eql(this.ajaxLimited.bucket);
    });
  });

  describe('integration tests', function() {
    beforeEach(function() {
      this.ajaxLimited = new AjaxLimited();
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);
    });

    afterEach(function() {
      this.ajaxLimited.restore();
    });

    beforeEach(function(done) {
      this.stats = {
        requests: 0,
        getRequests: 0,
        putRequests: 0,
        postRequests: 0,
        patchRequests: 0,
      };

      var _this = this;
      this.server = http.createServer(function(req, res) {
        _this.stats.requests++;
        _this.stats[req.method.toLowerCase() + 'Requests']++;
        res.write('Hello World');
        res.end();
      });
      this.server.listen(3000, done);
    });

    afterEach(function(done) {
      this.server.close(done);
    });

    it('$.ajax was patched to return a bluebird promise', function() {
      var p = $.ajax('http://localhost:3000');
      p.should.be.instanceof(Promise);
      return p;
    });

    it('$.ajax is limited', function() {
      this.timeout = 5000;
      var ps = [];
      var p;
      for(var i = 0; i < 20; i++) {
        p = $.ajax('http://localhost:3000').catch(function() {});
        ps.push(p);
      }

      var _this = this;
      return Promise.delay(3000).then(function() {
        _this.stats.requests.should.be.below(10);
        return Promise.all(ps);
      });
    });

    it('we can limit $.ajax per method', function() {
      var ps = [];
      var p;
      var start = new Date();
      var timer = Promise.delay(3000);
      this.ajaxLimited.get({
        bucketSize: 2,
        tokensPerInterval: 2,
      });

      for(var i = 0; i < 10; i++) {
        p = $.ajax({
          url: 'http://localhost:3000',
          type: 'POST',
          data: 'hello'
        }).catch(_.noop);
        ps.push(p);
        p = $.ajax('http://localhost:3000').catch(_.noop);
        ps.push(p);
      }

      var _this = this;

      return timer.then(function() {
        var elapsed = new Date().getTime() - start;
        var ncycles = elapsed / 3000;
        _this.stats.requests.should.be.below(10 * ncycles);
        _this.stats.getRequests.should.be.below(3 * ncycles);
        return Promise.all(ps);
      });
    });
  });
});
