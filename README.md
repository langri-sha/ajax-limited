ajax-limited
============
[![Build Status](https://travis-ci.org/toggl/ajax-limited.svg)](https://travis-ci.org/toggl/ajax-limited)
[![Coverage Status](https://coveralls.io/repos/toggl/ajax-limited/badge.svg?branch=master&service=github)](https://coveralls.io/github/toggl/ajax-limited?branch=master)
- - -
A rate-limited version of $.ajax with support for slow start on wakeup.

## Installing
```
npm install --save ajax-limited
```

## Usage
```javascript
var $ = require('jquery');
var ajaxLimited = require('ajax-limited');

ajaxLimited.configure($, {
  bucketSize: 9,
  tokensPerInterval: 9,
  interval: 3000,
});

ajaxLimited.get({
  bucketSize: 2,
  tokensPerInterval: 2,
  interval: 3000,
});
```

## Documentation
### AjaxLimited

Manages the set of `TokenBucket`s limitting AJAX requests.

#### Params:

* **Object** *[options]* Optional root `TokenBucket` options

### .prototype.configure(target, [options])

Configures rate limitting into an object.

#### Params:

* **Object** *target*
* **Object** *[options]*

### .prototype.restore([target])

Restores the original ajax method on the configured targets or a target
object.

#### Params:

* **Object** *[target]*

#### Return:

* **Function** originalAjax

### .prototype.slowStart(options)

Receives initial options for each HTTP method (or all of them), modifies
buckets so they start with them and slowly transitions rate limitting until
the original rates are reached.

#### Params:

* **Object** *options*

#### Example
```javascript
ajaxLimited.slowStart({
  get: { // Slows down get to this rate
    bucketSize: 9,
    tokensPerInterval: 9
  },
  'put,patch,post,delete': { // Slows down post, put, patch, delete to this rate
    bucketSize: 9,
    tokensPerInterval: 0,
  },
  transitionTime: 9000, // Takes 9s to reach normal speed
  interval: 3000        // Updates speed every 3s
});
```
