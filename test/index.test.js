'use strict';
/* jshint -W079 */
/* global describe, it, beforeEach, afterEach */
var $ = require('jquery');
var Promise = require('bluebird');
var _ = require('lodash');
var chai = require('chai');
var makeStub = require('mocha-make-stub');
var ajaxLimited = require('..');

if(!process.browser) {
  var najax = require('najax');
  $.ajax = najax; // For testing on Node.js
} else {
  require('phantomjs-polyfill');
}

chai.should();

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

  describe('.prototype.getBucketFor(url, settings)', function() {
    it('returns the global bucket when there\'re no childs', function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);
      this.ajaxLimited.getBucketFor(['/', {}])
        .should.eql(this.ajaxLimited.bucket);
    });

    it('returns child buckets if they match the request', function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);

      this.ajaxLimited.get(_.defaults({
        bucketSize: 3
      }, DEFAULT_OPTIONS));

      var bucket = this.ajaxLimited.getBucketFor([{
        type: 'GET',
        url: 'https://localhost:3000',
      }]);

      bucket.should.not.eql(this.ajaxLimited.bucket);
      bucket.parentBucket.should.eql(this.ajaxLimited.bucket);
    });
  });

  describe('integration tests', function() {
    describe('when AJAX is successful', function() {
      beforeEach(function() {
        this.stats = {
          requests: 0,
          getRequests: 0,
          putRequests: 0,
          postRequests: 0,
          patchRequests: 0,
        };
      });

      afterEach(function() {
        this.ajaxLimited.restore();
      });

      makeStub.each($, 'ajax', function(url, options) {
        if(!options) {
          options = url || {};
          url = options.url;
        }

        this.stats.requests++;
        var method = (options.type || options.method || 'get').toLowerCase();
        this.stats[method + 'Requests']++;
        return Promise.resolve({});
      }, true);

      beforeEach(function() {
        this.ajaxLimited = new AjaxLimited();
        this.ajaxLimited.configure($, DEFAULT_OPTIONS);
      });

      it('$.ajax was patched to return a bluebird promise', function() {
        var p = $.ajax('http://localhost:3000');
        p.should.be.instanceof(Promise);
        return p;
      });

      it('$.ajax is limited', function() {
        this.timeout(10000);
        var ps = [];
        var p;
        for(var i = 0; i < 20; i++) {
          p = $.ajax('http://localhost:3000').catch(function() {});
          ps.push(p);
        }

        var _this = this;
        return Promise.delay(3000).then(function() {
          _this.stats.requests.should.be.below(10);
          _this.ajaxLimited.bucket.tokensPerInterval = 10000;
          return Promise.all(ps);
        });
      });

      it('we can limit $.ajax per method', function() {
        this.timeout(20000);
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
          _this.ajaxLimited.bucket.tokensPerInterval = 10000;
          _this.ajaxLimited.childBuckets.get.tokensPerInterval = 10000;
          return Promise.all(ps);
        });
      });
    });
  });
});
