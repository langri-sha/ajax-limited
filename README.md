ajax-limited
============
A rate-limited version of $.ajax with support for slow start on wakeup.

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
