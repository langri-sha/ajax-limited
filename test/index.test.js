'use strict';
/* jshint -W079 */
/* global describe, it, beforeEach, afterEach */
var $ = require('jquery');
var Promise = require('bluebird');
var _ = require('lodash');
var chai = require('chai');
var limiter = require('limiter');
var makeStub = require('mocha-make-stub');
var sinon = require('sinon');
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
  interval: 300,
};

var AjaxLimited = ajaxLimited.AjaxLimited;

describe('AjaxLimited([options])', function() {
  beforeEach(function() {
    this.ajaxLimited = new AjaxLimited();
  });

  afterEach(function() {
    this.ajaxLimited.restore();
  });

  it("doesn't throw", function() {
    new AjaxLimited();
  });

  it('initializes the root bucket if options are provided', function() {
    var a = new AjaxLimited(DEFAULT_OPTIONS);
    a.should.have.property('bucket');
    a.bucket.should.be.instanceof(limiter.TokenBucket);
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

  describe('.prototype.registerBucket(method, options)', function() {
    it("creates new buckets when they don't exist yet", function() {
      this.ajaxLimited.registerBucket('get', DEFAULT_OPTIONS);
      this.ajaxLimited.childBuckets.should.have.property('get');
      this.ajaxLimited.childBuckets.get.bucketSize.should.equal(DEFAULT_OPTIONS.bucketSize);
    });

    it("updates existing buckets, if they're already there", function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);
      var oldBucket = this.ajaxLimited.registerBucket('get', DEFAULT_OPTIONS);
      this.ajaxLimited.registerBucket('get', {bucketSize: 0});
      this.ajaxLimited.childBuckets.should.have.property('get');
      this.ajaxLimited.childBuckets.get.parentBucket
        .should.equal(this.ajaxLimited.bucket);
      this.ajaxLimited.childBuckets.get.tokensPerInterval
        .should.equal(DEFAULT_OPTIONS.tokensPerInterval);
      this.ajaxLimited.childBuckets.get.bucketSize.should.equal(0);
      this.ajaxLimited.childBuckets.get.should.eql(oldBucket);
    });

    it('handles updating the root bucket', function() {
      this.ajaxLimited.configure($, DEFAULT_OPTIONS);
      var oldBucket = this.ajaxLimited.registerBucket('all', DEFAULT_OPTIONS);
      this.ajaxLimited.registerBucket('all', {bucketSize: 0});
      this.ajaxLimited.bucket.should.eql(oldBucket);
      this.ajaxLimited.bucket.tokensPerInterval
        .should.equal(DEFAULT_OPTIONS.tokensPerInterval);
      this.ajaxLimited.bucket.bucketSize.should.equal(0);
    });
  });

  describe('.prototype.slowStart', function() {
    it('slowly transitions from one bucket state to another', function() {
      var _this = this;

      this.ajaxLimited.configure($, {
        bucketSize: 10,
        tokensPerInterval: 10,
        interval: 200,
      });

      this.ajaxLimited.bucket.bucketSize.should.equal(10);
      this.ajaxLimited.bucket.tokensPerInterval.should.equal(10);
      this.ajaxLimited.bucket.interval.should.equal(200);

      this.ajaxLimited.slowStart({
        all: {
          bucketSize: 0,
          tokensPerInterval: 1,
        },
        transitionTime: 1000,
        interval: 500,
      });

      this.ajaxLimited.bucket.bucketSize.should.equal(0);
      this.ajaxLimited.bucket.tokensPerInterval.should.equal(1);
      this.ajaxLimited.bucket.interval.should.equal(200);

      return Promise.delay(100).then(function() {
        _this.ajaxLimited.bucket.bucketSize.should.equal(0);
        _this.ajaxLimited.bucket.tokensPerInterval.should.equal(1);
        _this.ajaxLimited.bucket.interval.should.equal(200);
        return Promise.delay(500).then(function() {
          _this.ajaxLimited.bucket.bucketSize.should.not.equal(0);
          _this.ajaxLimited.bucket.tokensPerInterval.should.equal(6);
          _this.ajaxLimited.bucket.interval.should.equal(200);
        });
      });
    });
  });

  describe('.prototype.ajax', function() {
    it('removes tokens from the root bucket before triggering AJAX', function() {
      var _this = this;
      var ajaxSpy = sinon.spy();
      var target = { ajax: ajaxSpy, };
      this.ajaxLimited.configure(target, DEFAULT_OPTIONS);
      this.ajaxLimited.bucket.content = 1;
      return this.ajaxLimited.ajax({type: 'get'}).then(function() {
        Math.floor(_this.ajaxLimited.bucket.content).should.equal(0);
        ajaxSpy.called.should.be.ok;
      });
    });

    it('removes tokens from child buckets if applicable', function() {
      var _this = this;
      var ajaxSpy = sinon.spy();
      var target = { ajax: ajaxSpy, };
      this.ajaxLimited.configure(target, DEFAULT_OPTIONS);
      this.ajaxLimited.get({
        bucketSize: 1,
        tokensPerInterval: 3,
      });

      this.ajaxLimited.bucket.content = 2;
      this.ajaxLimited.childBuckets.get.content = 1;
      return this.ajaxLimited.ajax({type: 'get'}).then(function() {
        Math.floor(_this.ajaxLimited.bucket.content).should.equal(1);
        Math.floor(_this.ajaxLimited.childBuckets.get.content).should.equal(0);
        ajaxSpy.called.should.be.ok;
      });
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
        if(typeof options.success === 'function') options.success();
        if(typeof options.complete === 'function') options.complete();
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
        return Promise.delay(300).then(function() {
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
        var timer = Promise.delay(300);
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
          var ncycles = elapsed / 300;
          _this.stats.requests.should.be.below(10 * ncycles);
          _this.stats.getRequests.should.be.below(3 * ncycles);
          _this.ajaxLimited.bucket.tokensPerInterval = 10000;
          _this.ajaxLimited.childBuckets.get.tokensPerInterval = 10000;
          return Promise.all(ps);
        });
      });

      it('success, and complete handlers are called in order', function() {
        var success = sinon.spy();
        var complete = sinon.spy(function() {
          success.calledOnce.should.be.true;
        });
        return $.ajax('http://localhost:3000', {
          success: success,
          complete: complete
        }).then(function() {
          complete.calledOnce.should.be.true;
        });
      });
    });

    describe('when AJAX is unsuccessful', function() {
      afterEach(function() {
        this.ajaxLimited.restore();
      });

      makeStub.each($, 'ajax', function(url, options) {
        if(!options) {
          options = url || {};
          url = options.url;
        }

        if(typeof options.error === 'function') options.error();
        if(typeof options.complete === 'function') options.complete();
        return Promise.reject(new Error("AJAX Failed"));
      }, true);

      it('error, and complete handlers are called in order', function() {
        var error = sinon.spy();
        var complete = sinon.spy(function() {
          error.calledOnce.should.be.true;
        });

        return $.ajax('http://localhost:3000', {
          error: error,
          complete: complete
        }).then(function() {
          throw new Error("Ajax success handler should not be called when ajax fails");
        }, function() {
          complete.calledOnce.should.be.true;
        });
      });
    });
  });
});
