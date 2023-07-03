import { ethers } from 'hardhat'
import {
	EntryPoint,
	EntryPoint__factory,
	AccountFactory,
	Account,
	Account__factory,
	TestToken__factory,
	TestToken,
	ZkProverZkpVerifierWrapper,
	ZkProverZkpVerifierWrapper__factory,
  VerifyingPaymaster,
  VerifyingPaymaster__factory,
  TestOracle,
  TestOracle__factory
} from '../typechain-types'
import {
	AddressZero,
	createAccountOwner,
	createAddress,
	simulationResultCatch,
  MOCK_VALID_UNTIL,
  MOCK_VALID_AFTER,
	checkForBannedOps,
	generateBatchofERC20TransferOp
} from './testutils'
import { Wallet } from 'ethers'
import { expect } from 'chai'
import { fillAndSign } from './UserOp'
import { arrayify, hexConcat } from '@ethersproject/bytes'
import { defaultAbiCoder } from 'ethers/lib/utils'
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import { UserOperationStruct } from '../typechain-types/contracts/Account'
const notFund = true

describe('5.deposit-paymaster.test', () => {
	let entryPoint: EntryPoint
	let entryPointzkp: EntryPoint
	let verifier: ZkProverZkpVerifierWrapper
  let paymaster: VerifyingPaymaster
  let testOracle: TestOracle
	const ethersSigners = ethers.provider.getSigner()
  const ethersSignerAdmin = ethers.provider.getSigner(1)
	let accountOwner: Wallet
	let refundAccount: Wallet
	let account: Account
	let token: TestToken
	let beneficiaryAddress: string


	before(async () => {
		accountOwner = createAccountOwner()
		beneficiaryAddress = createAddress()
		refundAccount = createAccountOwner()

		entryPointzkp = await new EntryPoint__factory(ethersSigners).deploy(
			AddressZero
		)
		let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

		const factory = new ethers.ContractFactory(
			halo2zkpVerifierAbi,
			verifyCode,
			ethersSigners
		  );
		  const verifyContract = await factory.deploy();
		verifier = await new ZkProverZkpVerifierWrapper__factory(
			ethersSigners
		  ).deploy(verifyContract.address);
		entryPoint = await new EntryPoint__factory(ethersSigners).deploy(verifier.address)

		account = await new Account__factory(ethersSigners).deploy(
			entryPoint.address
		)
    token = await new TestToken__factory(ethersSigners).deploy()
    paymaster = await new VerifyingPaymaster__factory(ethersSigners).deploy(entryPoint.address,await ethersSigners.getAddress())
    testOracle = await new TestOracle__factory(ethersSigners).deploy()        
		console.log('entryPoint:%s, signer:%s', entryPoint.address, await ethersSigners.getAddress())
  
  })

  describe('#0-deposit-test', () => {
    let _Token: TestToken
    before(async () => {
      _Token = await new TestToken__factory(ethersSigners).deploy()
      await _Token.mint(await ethersSigners.getAddress(), 1000)
    })

    it('should succeed to addToken', async () => {
      await entryPoint.addToken(token.address, testOracle.address)
      expect(await entryPoint.oracles(token.address)).to.be.equal(testOracle.address)
    })

    it('should fail to addToken twice', async () => {
      await entryPoint.addToken(_Token.address, testOracle.address)
      await expect(entryPoint.addToken(_Token.address, testOracle.address)).to.be.revertedWith('Token already set')
    })

    it('should fail to deposit with token not set', async () => {
      let _Token2 = await new TestToken__factory(ethersSigners).deploy()
      await _Token2.mint(await ethersSigners.getAddress(), 1000)
      await _Token2.approve(entryPoint.address, ethers.constants.MaxUint256)
      await expect(entryPoint.addDepositFor(_Token2.address, accountOwner.address, 10)).to.be.revertedWith('unsupported token')
    })

    it('should succeed to deposit with token set', async () => {
      let _Token2 = await new TestToken__factory(ethersSigners).deploy()
      await entryPoint.addToken(_Token2.address, testOracle.address)
      await _Token2.mint(await ethersSigners.getAddress(), 1000)
      await _Token2.approve(entryPoint.address, ethers.constants.MaxUint256)
      await entryPoint.addDepositFor(_Token2.address, accountOwner.address, 10)
      expect( await entryPoint.balances(_Token2.address,accountOwner.address)).to.be.equal(10)
    })    

    it('should fail to withdraw without unlock', async () => {
      // let beneficiaryAddress = createAddress()
      // let _Token2 = await new TestToken__factory(ethersSigners).deploy()
      // await entryPoint.addToken(_Token2.address, testOracle.address)
      // await _Token2.mint(await ethersSigners.getAddress(), 1000)
      // await _Token2.approve(entryPoint.address, ethers.constants.MaxUint256)
      // await entryPoint.addDepositFor(_Token2.address, accountOwner.address, 10)
      // await expect(entryPoint.withdrawTokensTo(_Token2.address, beneficiaryAddress, 1)).to.be.revertedWith('DepositPaymaster: must unlockTokenDeposit')
    })
  })


	it('simulate transfer ERC20 with PayMaster', async () => {
		await paymaster.deposit({ value: ethers.utils.parseEther('1') })
		const userOp1 = await fillAndSign(
			{
				sender: account.address,
				paymasterAndData: hexConcat([
					paymaster.address,
					defaultAbiCoder.encode(
						['uint48', 'uint48', 'address', 'uint256'],
						[MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
					),
					'0x' + '00'.repeat(65)
				])
			},
			accountOwner,
			entryPoint
		)
		const hash = await paymaster.getHash(
			userOp1,
			MOCK_VALID_UNTIL,
			MOCK_VALID_AFTER,
			token.address,
			0
		)
		const sig = await ethersSigners.signMessage(arrayify(hash))
		const userOp = await fillAndSign(
			{
				...userOp1,
				paymasterAndData: hexConcat([
					paymaster.address,
					defaultAbiCoder.encode(
						['uint48', 'uint48', 'address', 'uint256'],
						[MOCK_VALID_UNTIL, MOCK_VALID_AFTER, token.address, 0]
					),
					sig
				])
			},
			accountOwner,
			entryPoint
		)
		const ops: UserOperationStruct[] = []

		const res = await entryPoint.callStatic
			.simulateValidation(userOp)
			.catch(simulationResultCatch)
		// expect(res.returnInfo.sigFailed).to.be.false
		expect(res.returnInfo.validAfter).to.be.equal(
			ethers.BigNumber.from(MOCK_VALID_AFTER)
		)
		expect(res.returnInfo.validUntil).to.be.equal(
			ethers.BigNumber.from(MOCK_VALID_UNTIL)
		)

		await entryPoint
        .simulateValidation(userOp, { gasLimit: 10e6 })
        .catch((e) => e)
		const block = await ethers.provider.getBlock('latest')
		const hashop = block.transactions[0]
		await checkForBannedOps(hashop, false)
	})    
})