// SiYuan - https://github.com/siyuan-note/siyuan
// Copyright (c) 2020-present, b3log.org
// SPDX-License-Identifier: AGPL-3.0-or-later

package api

import (
	"github.com/gin-gonic/gin"
	"github.com/siyuan-note/siyuan/kernel/apicontract"
)

var startFreeTrial = contractHandler(apicontract.StartFreeTrial, func(c *gin.Context, request apicontract.EmptyRequest) apicontract.Response[apicontract.Null] {
	return apicontract.Failure[apicontract.Null](-1, "定制版本已移除云端账号功能")
})
var useActivationcode = contractHandler(apicontract.UseActivationCode, func(c *gin.Context, request apicontract.ActivationCodeRequest) apicontract.Response[apicontract.Null] {
	return apicontract.Failure[apicontract.Null](-1, "定制版本已移除云端账号功能")
})
var checkActivationcode = contractHandler(apicontract.CheckActivationCode, func(c *gin.Context, request apicontract.CheckActivationCodeRequest) apicontract.Response[apicontract.Null] {
	return apicontract.Failure[apicontract.Null](-1, "定制版本已移除云端账号功能")
})
var deactivateUser = contractHandler(apicontract.DeactivateUser, func(c *gin.Context, request apicontract.EmptyRequest) apicontract.Response[apicontract.Null] {
	return apicontract.Failure[apicontract.Null](-1, "定制版本已移除云端账号功能")
})
var login = contractHandler(apicontract.AccountLogin, func(c *gin.Context, request apicontract.AccountLoginRequest) apicontract.Response[*apicontract.AccountLoginData] {
	return apicontract.Failure[*apicontract.AccountLoginData](-1, "定制版本已移除云端账号功能")
})
