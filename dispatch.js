var async = require('async'),
    util = require('util'),
    _ = require('underscore'),
    inspect = require('util').inspect,
    apiBackend = require('./backend'),
    Trip = require("./models/trip").Trip,
    tripRepository = require('./models/trip').repository,
    driverRepository = require('./models/driver').repository,
    clientRepository = require('./models/client').repository,
    Driver = require("./models/driver").Driver,
    Client = require("./models/client").Client,
    city = require("./models/city"),
    redis = require("redis").createClient(),
    ErrorCodes = require("./error_codes"),
    MessageFactory = require("./messageFactory"),
    mongoClient = require('./mongo_client');

function Dispatcher() {
    this.driverEventCallback = this._clientsUpdateNearbyDrivers.bind(this);
    this.channelClients = {};
    
    redis.subscribe('channel:drivers');
    redis.subscribe('channel:clients');
    redis.subscribe('channel:trips');

    // Broadcast message to clients
    redis.on('message', function(channel, message) {
        channel = channel.split(':')[1];
        if (!this.channelClients[channel]) return;

        this.channelClients[channel].forEach(function(connection){
            var data = JSON.stringify({channel: channel, data: JSON.parse(message)});
            
            try {
                connection.send(data);              
            }
            catch(e) {
                connection.close();
            };
        }, this);

    }.bind(this));  
}

Dispatcher.prototype = {
    Login: function(context, callback) {
        async.waterfall([
            function(nextFn) {
                apiBackend.loginClient(context.message.email, context.message.password, context.message.deviceId, nextFn);
            },
            function(client, nextFn) {
                client.login(context, nextFn);
            }
        ], callback);
    },

    SignUpClient: function(context, callback) {
        async.waterfall([
            function(nextFn) {
                var signUpInfo = {
                    first_name: context.message.firstName,
                    last_name: context.message.lastName,
                    mobile: context.message.mobile,
                    password: context.message.password,
                    email: context.message.email
                }

                apiBackend.signupClient({ user: signUpInfo }, nextFn);
            },
            function(client, response, nextFn) {
                if (client)
                    client.login(context, nextFn);
                else
                    nextFn(null, response);
            }
        // error, result
        ], callback);
    },
    
    PingClient: function(context, callback) {
        clientRepository.get(context.message.id, function(err, client) {
            if (err) return callback(err);

            client.ping(context, callback);
        });
    },

    Pickup: function(context, callback) {
        clientRepository.get(context.message.id, function(err, client) {
            if (err) return callback(err);

            client.pickup(context, callback);
        });
    },

    // TODO: Записать в Client lastEstimatedTrip расчет поездки
    // И сохранять для каждого клиента это в базе
    SetDestination: function(context, callback) {
        clientRepository.get(context.message.id, function(err, client) {
            if (err) return callback(err);

            city.estimateFare(client, context.message, callback);
        });
    },
    
    PickupCanceledClient: function(context, callback) {
        clientRepository.get(context.message.id, function(err, client) {
            if (err) return callback(err);

            client.cancelPickup(context, callback);
        });
    },

    // TODO: Убрать когда выпустишь новую версию iOS Client
    CancelTripClient: function(context, callback) { 
        this.PickupCanceledClient(context, callback);
    },

    RatingDriver: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip){
            if (err) return callback(err);

            trip.clientRateDriver(context, callback);
        });
    },

    LoginDriver: function(context, callback) {
        apiBackend.loginDriver(context.message.email, context.message.password, context.message.deviceId, function(err, driver){
            if (err) return callback(err);

            this._subscribeToDriverEvents(driver);

            callback(null, driver.login(context));  
        }.bind(this));
    },

    LogoutDriver: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            callback(null, driver.logout(context));
        });
    },

    OffDutyDriver: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            callback(null, driver.offDuty(context));
        });
    },

    OnDutyDriver: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err, null);

            callback(null, driver.onDuty(context));
        });
    },

    PingDriver: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            callback(null, driver.ping(context));
        });
    },

    ConfirmPickup: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip){
            if (err) return callback(err);

            trip.confirm(context, callback);
        });
    },

    ArrivingNow: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip){
            if (err) return callback(err);

            trip.driverArriving(context, callback);
        });
    },

    BeginTripDriver: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip){
            if (err) return callback(err);

            trip.driverBegin(context, callback);
        });
    },

    PickupCanceledDriver: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            driver.cancelPickup(context, callback);
        });
    },
    
    EndTrip: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip) {
            if (err) return callback(err);

            trip.driverEnd(context, callback);
        });
    },

    ListVehicles: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            driver.listVehicles(callback);
        });
    },

    SelectVehicle: function(context, callback) {
        driverRepository.get(context.message.id, function(err, driver) {
            if (err) return callback(err);

            driver.selectVehicle(context, callback);
        });
    },

    RatingClient: function(context, callback) {
        tripRepository.get(context.message.tripId, function(err, trip){
            if (err) return callback(err);

            trip.driverRateClient(context, callback);
        });
    },

    ApiCommand: function(context, callback) {
        if (context.message.id) {
            clientRepository.get(context.message.id, function(err, client) {
                if (err) return callback(err);

                apiBackend.apiCommand(client, context.message, callback);
            });
        }
        else
            apiBackend.apiCommand(null, context.message, callback);
    },

    Subscribe: function(context, callback) {
        if (!context.message.channel) return callback(new Error('channel could not be empty'));

        // Client subscriptions management
        this.channelClients[context.message.channel] = this.channelClients[context.message.channel] || [];
        var clients = this.channelClients[context.message.channel];
        clients.push(context.connection);

        console.log("Subscribe to " + context.message.channel);
        console.log("Channel " + context.message.channel + " has " + clients.length + " subscriber");
        
        // Remove disconnected clients
        context.connection.once('close', function() {
            index = clients.indexOf(context.connection);
            if (index > -1) {
                console.log('Remove subscriber from ' + context.message.channel);
                clients.splice(index, 1);
            }
        });

        // Push initial state
        if (context.message.channel === 'drivers') {
            Driver.publishAll();
        } else if (context.message.channel === 'clients') {
            Client.publishAll();
        } else if (context.message.channel === 'trips') {
            Trip.publishAll();
        }       
    }
}

function responseWithError(text, errorCode){
    var msg = MessageFactory.createError(text, errorCode);

    console.log('Sending response:');
    console.log(util.inspect(msg, {depth: 3}));

    try {
        this.send(JSON.stringify(msg));    
    }
    catch(e) {

    };
}

Dispatcher.prototype._parseJSONData = function(data, connection) {
    var message;
    try {
      message = JSON.parse(data);
      console.log(util.inspect(message, {depth: 3, colors: true}));
    }
    catch(e) {
      responseWithError.call(connection, e.message);
    }

    return message;
}

Dispatcher.prototype._findMessageHandler = function(message, connection) {
    if (message.app !== 'client' && message.app !== 'driver' && message.app !== 'god') {
        return responseWithError.call(connection, 'Unknown client app: ' + message.app);
    }

    var handler = this.__proto__[message.messageType];
    if (!handler) {
        return responseWithError.call(connection, 'Unsupported message type: ' + message.messageType);
    }

    return handler;
}

// Update all clients except the one requested pickup
Dispatcher.prototype._clientsUpdateNearbyDrivers = function(driver, clientRequestedPickup) {
    var skipClientId = clientRequestedPickup ? clientRequestedPickup.id : null;

    if (!driver.connected) driver.removeAllListeners();

    clientRepository.each(function(client) {
        if (client.id === skipClientId) return;

        client.sendDriversNearby();
    });
}

// Subscribe to driver events (1 time)
Dispatcher.prototype._subscribeToDriverEvents = function(driver) {
    driver.removeAllListeners();

    _.each(['connect', 'disconnect', 'available', 'unavailable'], function(eventName){
        driver.on(eventName, this.driverEventCallback);
    }.bind(this));
}

Dispatcher.prototype._accessWithoutToken = function(methodName) {
    return ["Login", "ApiCommand", "LoginDriver", "SignUpClient", "Subscribe"].indexOf(methodName) > -1;
}

Dispatcher.prototype._tokenValid = function(message, connection) {
    var user;
    if (message.app === "client") {
        user = clientRepository.get(message.id);
    } 
    else if (message.app === "driver") {
        user = driverRepository.get(message.id);
    }

    if (user && !user.isTokenValid(message)) {
        responseWithError.call(connection, "Доступ запрещен", ErrorCodes.INVALID_TOKEN);
        return false;
    }
    
    return true;
}

Dispatcher.prototype.load = function(callback) {
    var self = this;
    async.parallel({
        drivers: driverRepository.all.bind(driverRepository),
        clients: clientRepository.all.bind(clientRepository),
        trips: tripRepository.all.bind(tripRepository)
    },
    function(err, result){
        async.parallel([
            function(next) {
                // console.log('Cache ' + result.drivers.length + ' driver(s)');
                async.each(result.drivers, function(driver, cb){
                    self._subscribeToDriverEvents(driver);
                    driver.load(cb);
                }, next);
            },
            function(next) {
                // console.log('Cache ' + result.clients.length + ' client(s)');
                async.each(result.clients, function(client, cb){
                    client.load(cb);
                }, next);
            },
            function(next) {
                // console.log('Cache ' + result.trips.length + ' trip(s)');
                async.each(result.trips, function(trip, cb){
                    trip.load(function(err) {
                        if (err) console.log('Error loading trip ' + trip.id + ':' + err);
                        cb()
                    });
                }, next);
            }

        ], callback);
    });
}

Dispatcher.prototype.processMessage = function(data, connection) {
    console.log("Process message:");
    // console.log(data);

    var message;
    if (!(message = this._parseJSONData(data, connection))) return;

    // Find message handler
    var messageHandler;
    if (!(messageHandler = this._findMessageHandler(message, connection))) return;

    // Validate token
    if (!this._accessWithoutToken(message.messageType) && !this._tokenValid(message, connection)) return;

    // Process request and send response
    messageHandler.call(this, {message: message, connection: connection}, function(err, result) {
        if(err) {
            console.log(err.stack);
            return responseWithError.call(connection, err.message);
        }

        console.log('Sending response:');
        console.log(util.inspect(result, {depth: 3}));

        // Send response
        connection.send(JSON.stringify(result), function(err) {
            if (err) return console.log(err);
        });
    });
}

module.exports = Dispatcher;