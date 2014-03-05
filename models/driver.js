var MessageFactory = require("../messageFactory"),
  LatLon = require('../latlon'),
  util = require("util"),
  async = require("async"),
  Repository = require('../lib/repository'),
  DistanceMatrix = require('../lib/google-distance'),
  User = require("./user");

function Driver() {
  User.call(this, Driver.OFFDUTY);
  this.tripsRejected = this.tripsRejected || 0; 
  this.tripsAccepted = this.tripsRejected || 0;
}

util.inherits(Driver, User);

var repository = new Repository(Driver);
var DEFAULT_PICKUP_TIME_SECONDS = 20 * 60;

/**
 * Driver States
 */

['OffDuty', 'Available', 'Dispatching', 'Accepted', 'Arrived', 'DrivingClient', 'PendingRating'].forEach(function (readableState, index) {
  var state = readableState.toUpperCase();
    Driver.prototype[state] = Driver[state] = readableState;
});

Driver.prototype.getSchema = function() {
  var props = User.prototype.getSchema.call(this);
  props.push('vehicle');
  props.push('tripsAccepted');
  props.push('tripsRejected');
  return props;
}

Driver.prototype.login = function(context, callback) {
  console.log('Driver ' + this.id + ' logged in: ' + this.state + ' connected: ' + this.connected);
  this.updateLocation(context);
  this.changeState(Driver.OFFDUTY);

  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this, true, this.trip, this.state === Driver.PENDINGRATING));
  }.bind(this));
}

Driver.prototype.changeState = function(state, client) {
  User.prototype.changeState.call(this, state);
  
  if (this.state === Driver.AVAILABLE) {
    this.emit('available', this);
    this.clearTrip();
  }
  else {
    this.emit('unavailable', this, client);
  }
}

Driver.prototype.logout = function(context, callback) {
  console.log('Driver ' + this.id + ' logged out');
  this.updateLocation(context);
  this.changeState(Driver.OFFDUTY);

  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype.onDuty = function(context, callback) {
  console.log('Driver ' + this.id + ' on duty');
  this.updateLocation(context);
  this.changeState(Driver.AVAILABLE);

  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype.offDuty = function(context, callback) {
  console.log('Driver ' + this.id + ' off duty');
  this.updateLocation(context);
  this.changeState(Driver.OFFDUTY);

  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this));
  }.bind(this));
}

// Update driver's position
Driver.prototype.ping = function(context, callback) {
  this.updateLocation(context);
  // Track trip route
  if (this.trip) {
    this.trip.driverPing(context);
  }

  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this, false, this.trip, this.state === Driver.PENDINGRATING))
  }.bind(this));
}

// TODO: Если произошла ошибка посылки Заказа водителю или ошибка сохранения, то перевести водителя в AVAILABLE
Driver.prototype.dispatch = function(client, trip, callback) {
  this.changeState(Driver.DISPATCHING, client);
  this.setTrip(trip);

  async.series([
    this.send.bind(this, MessageFactory.createDriverPickup(this, trip, client)),
    this.save.bind(this)
  ], callback);
}

Driver.prototype.save = function(callback) {
  repository.save(this, callback);  
}

// Notify driver that Client canceled pickup or pickup timed out
Driver.prototype.notifyPickupCanceled = function(reason) {
  if (!this.trip) return;

  this.changeState(Driver.AVAILABLE);
  this.send(MessageFactory.createDriverPickupCanceled(this, reason));
  this.save();
}

Driver.prototype.notifyPickupTimeout = function() {
  this.tripsRejected += 1;
  this.notifyPickupCanceled();
}

Driver.prototype.notifyTripCanceled = function() {
  if (!this.trip) return;

  this.changeState(Driver.AVAILABLE);
  this.send(MessageFactory.createDriverTripCanceled(this, "Клиент отменил заказ."));
  this.save();
}

// Driver explicitly canceled trip
Driver.prototype.cancelTrip = function(context) {
  this.updateLocation(context);
  this.changeState(Driver.AVAILABLE);
  this.save();

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.confirm = function(context) {
  if (this.state === Driver.ACCEPTED) return MessageFactory.createDriverOK(this);

  this.tripsAccepted += 1;
  this.updateLocation(context);
  this.changeState(Driver.ACCEPTED);
  this.save();

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.arriving = function(context, callback) {
  this.updateLocation(context);
  this.changeState(Driver.ARRIVED);
  this.save(function(err) {
    callback(err, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype.begin = function(context) {
  this.updateLocation(context);
  this.changeState(Driver.DRIVINGCLIENT);
  this.save();
  return MessageFactory.createDriverOK(this);
}

Driver.prototype.finishTrip = function(context) {
  this.updateLocation(context);
  this.changeState(Driver.PENDINGRATING);
  this.save();

  return MessageFactory.createDriverOK(this, false, this.trip, true);
}

Driver.prototype.rateClient = function(context, callback) {
  if (this.state !== Driver.PENDINGRATING) return callback(null, MessageFactory.createDriverOK(this));

  this.updateLocation(context);
  
  require('../backend').rateClient(this.trip.id, context.message.rating, function() {
    this.changeState(Driver.AVAILABLE);
    this.save();

    callback(null, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype._distanceTo = function(location) {
  // FIXME: Оптимизировать позже
  return new LatLon(this.location.latitude, this.location.longitude).distanceTo(new LatLon(location.latitude, location.longitude), 4);
}

Driver.prototype.isDrivingClient = function() {
  return this.state === Driver.DRIVINGCLIENT;
}

function isAvailable(driver, callback) {
  console.log('+ isAvailable: Driver ' + driver.id + ' => ' + driver.connected + ', ' + driver.state);
  callback(driver.connected && driver.state === Driver.AVAILABLE);
}

function locationToString(location) {
  return location.latitude + ',' + location.longitude
}

function findAvailableDrivers(callback) {
  // bind function context and first (err) param to null
  repository.filter(isAvailable, callback.bind(null, null));
}

// TODO: Нужно кэшировать полученные расстояния когда координаты origin и destination входят в небольшой bounding box или geofence с радиусом
// Иначе очень быстро исчерпаются временной и дневной лимиты на запросы к Google Maps Distance Matrix API
Driver.prototype.queryETAToLocation = function(location, callback) {
  DistanceMatrix.get({
    origin: locationToString(this.location),
    destination: locationToString(location)
  }, function(err, data) {
    if (err) {
      data = { durationSeconds: DEFAULT_PICKUP_TIME_SECONDS };
      console.log(err);
    }

    var eta = Math.ceil(data.durationSeconds / 60);
    callback(null, eta);
  });
}

Driver.prototype.toJSON = function() {
  var obj = User.prototype.toJSON.call(this);
  if (this.trip) {
    obj.trip = {
      id: this.trip.id,
      pickupLocation: this.trip.pickupLocation
    }
  }
  return obj;
}

Driver.prototype.listVehicles = function(callback) {
  console.log("+ Driver.prototype.listVehicles");
  require('../backend').listVehicles(this, function(err, vehicles) {
    callback(err, MessageFactory.createDriverVehicleList(this, vehicles));
  }.bind(this));
}

Driver.prototype.selectVehicle = function(context, callback) {
  require('../backend').selectVehicle(this, context.message.vehicleId, function(err, vehicle) {
    if (err) return callback(err);

    this.vehicle = vehicle;
    callback(null, MessageFactory.createDriverOK(this));
  }.bind(this));
}

function vehicleLocationsWithTimeToLocation(location, drivers, callback) {
  async.map(drivers, function(driver, next) {
    driver.queryETAToLocation(location, function(err, eta) {
      var v = {
        id: driver.vehicle.id,
        longitude: driver.location.longitude, 
        latitude: driver.location.latitude,
        eta: eta
      };

      next(null, v);
    });
  }, callback);
}

Driver.findAllAvailableNearLocation = function(location, callback) {
  async.waterfall([
    findAvailableDrivers,
    vehicleLocationsWithTimeToLocation.bind(null, location)
  ], callback);
}

Driver.findAllAvailableOrderByDistance = function(pickupLocation, callback) {
  async.waterfall([
    findAvailableDrivers,
    // find distance to each driver
    function(availableDrivers, nextFn) {
      console.log('Available drivers:');
      console.log(util.inspect(availableDrivers, { colors:true }));

      async.map(
        availableDrivers,
        function(driver, cb) {
          // distance from client in km
          var distanceToClient = driver._distanceTo(pickupLocation);
          cb(null, { driver: driver, distanceToClient: distanceToClient });
        }, 
        nextFn
      );      
    },
    // order drivers by distance
    function(driversAndDistances, nextFn) { 
      async.sortBy(
        driversAndDistances, 
        function(item, cb) { cb(null, item.distanceToClient) },
        nextFn
      );
    }
  ], callback);
}

Driver.findOneAvailableNearPickupLocation = function(pickupLocation, callback) {
  Driver.findAllAvailableOrderByDistance(pickupLocation, function(err, driversWithDistance){
    if (err) return callback(err);

    console.log('Drivers in ascending order by distance from client pickup location:');
    console.log(util.inspect(driversWithDistance,{colors:true}));

    if (driversWithDistance.length === 0) return callback(new Error('No available drivers'));

    callback(null, driversWithDistance[0].driver);
  });
}

Driver.publishAll = function() {
  repository.all(function(err, drivers) {
    drivers.forEach(function(driver) {
      driver.publish();
    });
  });
}

// export Driver constructor
module.exports.Driver = Driver;
module.exports.repository = repository;